import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"
import {
  API_PREFIX,
  compileRequestSchema,
  stampConfigYaml,
  stampPackSchema,
  type StampPackInput,
} from "@workspace/shared"

import { CompileQueue, type CompiledArtifact } from "./compile.js"
import { env, dataPath } from "./env.js"
import { errorBody, isHelperArtifact, pathExists, signUpdateToken, verifyUpdateToken } from "./lib.js"
import { zipBuffers, type ZipEntry } from "./zip.js"

function windowsInstallPs1(hasBinary: boolean): string {
  return `#Requires -RunAsAdministrator
param([string]$InstallDir = "$env:ProgramFiles\\PC Manager Agent")
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Set-ServiceRecovery([string]$Name) {
  if (-not $Name) { return }
  try {
    & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
    & sc.exe failureflag $Name 1 | Out-Null
  } catch {
    Write-Warning "Could not set SCM recovery on $Name : $_"
  }
}

function Stop-InstalledServices {
  foreach ($name in @("PCManagerHelper", "PCManagerAgent")) {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
      try { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

$helperExeName = "pc-manager-helper.exe"
$exeName = "pc-manager-agent.exe"
$destHelper = Join-Path $InstallDir $helperExeName
$destAgent = Join-Path $InstallDir $exeName

if (Test-Path $destHelper) {
  try { & $destHelper stop | Out-Null } catch {}
  try { & $destHelper uninstall | Out-Null } catch {}
}
if (Test-Path $destAgent) {
  try { & $destAgent uninstall | Out-Null } catch {}
}
Stop-InstalledServices

$configSrc = Join-Path $Root "config.yaml"
$configDest = Join-Path $InstallDir "config.yaml"
if ((Test-Path $configSrc) -and -not (Test-Path $configDest)) {
  Copy-Item $configSrc $configDest -Force
}

$helperInstalled = $false
$helperExe = $null
$helperSrc = Join-Path $Root $helperExeName
if (-not (Test-Path $helperSrc)) {
  $helperSrc = Join-Path $Root "dist\\pc-manager-helper-windows-amd64.exe"
}
if (Test-Path $helperSrc) {
  Write-Host "Installing watchdog helper first..."
  try {
    Copy-Item $helperSrc $destHelper -Force
    $helperConfig = Join-Path $InstallDir "helper.yaml"
    if (-not (Test-Path $helperConfig)) {
      Write-Utf8NoBom $helperConfig @"
agent_service_name: PCManagerAgent
status_port: 17890
backoff_sec: 30
"@
    }
    $helperExe = $destHelper
    & $helperExe install
    Set-ServiceRecovery "PCManagerHelper"
    $helperInstalled = $true
  } catch {
    Write-Warning "Helper install failed; continuing with agent-only. $_"
    $helperInstalled = $false
  }
} else {
  Write-Warning "pc-manager-helper.exe was not found in this pack; installing the agent only (no watchdog)."
}

$src = Join-Path $Root $exeName
if (-not (Test-Path $src)) { $src = Join-Path $Root "pc-manager-agent" }
if (-not (Test-Path $src)) {
  Write-Host "Stamp pack has config but no agent binary. Copy $exeName into $InstallDir and install the service."
  exit ${hasBinary ? "1" : "0"}
}
Stop-InstalledServices
Copy-Item $src $destAgent -Force
$exe = $destAgent
& $exe install
Set-ServiceRecovery "PCManagerAgent"
if ($helperInstalled) {
  try { & $helperExe start } catch { Write-Warning "Helper start failed: $_" }
}
& $exe start
Write-Host "Installed Mnag.pt Agent. Config: $configDest"
if ($helperInstalled) {
  Write-Host "Installed Mnag.pt Helper watchdog (PCManagerHelper)."
}
Write-Host "SCM restart on failure is set for both services (5s / 30s / 60s)."
Write-Host "To stop for real (helper then agent): & '$exe' stop"
`
}

function unixInstallSh(hasBinary: boolean): string {
  const exitNoBin = hasBinary ? "1" : "0"
  return `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="\${INSTALL_DIR:-/opt/pc-manager-agent}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo mkdir -p "$INSTALL_DIR"
if [[ -f "$SCRIPT_DIR/config.yaml" ]]; then
  sudo cp "$SCRIPT_DIR/config.yaml" "$INSTALL_DIR/config.yaml"
  sudo chmod 600 "$INSTALL_DIR/config.yaml"
fi
BIN_SRC="$SCRIPT_DIR/pc-manager-agent"
if [[ ! -f "$BIN_SRC" ]]; then
  echo "Stamp pack has config but no agent binary."
  echo "Place pc-manager-agent in $INSTALL_DIR then: sudo systemctl enable --now pc-manager-agent"
  exit ${exitNoBin}
fi
sudo cp "$BIN_SRC" "$INSTALL_DIR/pc-manager-agent"
sudo chmod +x "$INSTALL_DIR/pc-manager-agent"
sudo tee /etc/systemd/system/pc-manager-agent.service >/dev/null <<EOF
[Unit]
Description=Mnag.pt Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=\${INSTALL_DIR}
ExecStart=\${INSTALL_DIR}/pc-manager-agent run
Restart=always
RestartSec=5
Environment=PC_MANAGER_CONFIG=\${INSTALL_DIR}/config.yaml

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now pc-manager-agent
echo "Installed Mnag.pt Agent. Edit $INSTALL_DIR/config.yaml then: sudo systemctl restart pc-manager-agent"
`
}

function packReadme(input: StampPackInput, hasBinary: boolean, binaryNote: string): string {
  return [
    "Mnag.pt agent stamp pack",
    `Platform: ${input.platform}/${input.arch}`,
    `Binary: ${hasBinary ? binaryNote : "not included — config + installer only"}`,
    "",
    "config.yaml contains the enrollment secret. Treat this zip as confidential.",
    "Download links expire after 10 minutes; refresh the pack list for a new URL.",
    input.platform === "windows" ? "Run install.ps1 as Administrator." : "Run: sudo bash install.sh",
    "",
  ].join("\n")
}

function signedPackUrl(id: string): { url: string; path: string; exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + 600
  const sig = signUpdateToken(id, exp)
  const qs = `id=${encodeURIComponent(id)}&exp=${exp}&sig=${sig}`
  const rel = `${API_PREFIX}/builder/download?${qs}`
  return { url: `${env.publicUrl}${rel}`, path: rel, exp, sig }
}

function helperName(platform: string): string {
  return platform === "windows" ? "pc-manager-helper.exe" : "pc-manager-helper"
}

function agentName(platform: string): string {
  return platform === "windows" ? "pc-manager-agent.exe" : "pc-manager-agent"
}

async function latestMatchingUpdate(platform: string, arch: string, helper: boolean) {
  const rows = await prisma.agentUpdate.findMany({
    where: { platform, arch, kind: helper ? "helper" : "agent" },
    orderBy: { createdAt: "desc" },
  })
  for (const row of rows) {
    if (!(await pathExists(row.path))) continue
    return row
  }
  return null
}

async function listHelperBinaries() {
  const rows = await prisma.agentUpdate.findMany({
    where: { kind: "helper" },
    orderBy: { createdAt: "desc" },
  })
  const seen = new Set<string>()
  const out: Array<{ id: string; platform: string; arch: string; version: string }> = []
  for (const row of rows) {
    if (!isHelperArtifact(row.path, row.notes)) continue
    const key = `${row.platform}/${row.arch}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await pathExists(row.path))) continue
    out.push({ id: row.id, platform: row.platform, arch: row.arch, version: row.version })
  }
  return out
}

async function persistCompiledUpdate(artifact: CompiledArtifact) {
  const kind = "agent"
  const existing = await prisma.agentUpdate.findUnique({
    where: {
      kind_version_platform_arch: {
        kind,
        version: artifact.version,
        platform: artifact.platform,
        arch: artifact.arch,
      },
    },
  })
  if (existing && existing.path !== artifact.path) {
    await fsp.unlink(existing.path).catch(() => undefined)
  }
  return prisma.agentUpdate.upsert({
    where: {
      kind_version_platform_arch: {
        kind,
        version: artifact.version,
        platform: artifact.platform,
        arch: artifact.arch,
      },
    },
    create: { ...artifact, kind },
    update: {
      notes: artifact.notes,
      checksum: artifact.checksum,
      path: artifact.path,
      size: artifact.size,
      createdAt: new Date(),
    },
  })
}

const compileQueue = new CompileQueue({
  sourceDir: env.agentSourceDir,
  goBin: env.goBin,
  updatesDir: dataPath("updates"),
  persist: persistCompiledUpdate,
})

export async function registerBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/builder/packs`, async () => {
    const [packs, helperAvailable] = await Promise.all([
      prisma.agentBuild.findMany({ orderBy: { createdAt: "desc" } }),
      listHelperBinaries(),
    ])
    return {
      compileEnabled: env.enableAgentCompile,
      helperAvailable,
      packs: await Promise.all(
        packs.map(async (row) => {
          const signed = signedPackUrl(row.id)
          let size = 0
          try {
            size = (await fsp.stat(row.path)).size
          } catch {
            /* missing */
          }
          return {
            ...row,
            size,
            hasHelper: /helper binary/i.test(row.notes ?? ""),
            downloadUrl: signed.path,
            downloadUrlAbsolute: signed.url,
            expiresAt: signed.exp,
          }
        })
      ),
    }
  })

  app.post(`${API_PREFIX}/admin/builder/packs`, async (req, reply) => {
    const parsed = stampPackSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const input = parsed.data
    const latest = await latestMatchingUpdate(input.platform, input.arch, false)
    let binary: Buffer | null = null
    const binaryName = agentName(input.platform)
    let binaryNote = ""
    if (latest) {
      binary = await fsp.readFile(latest.path)
      binaryNote = `${latest.platform}/${latest.arch} ${latest.version}`
    }
    const hasBinary = Boolean(binary)
    let helper: Buffer | null = null
    let helperNote = ""
    if (input.includeHelper) {
      const helperRow = await latestMatchingUpdate(input.platform, input.arch, true)
      if (helperRow) {
        helper = await fsp.readFile(helperRow.path)
        helperNote = `${helperRow.platform}/${helperRow.arch} ${helperRow.version}`
      }
    }
    const hasHelper = Boolean(helper)
    const files: ZipEntry[] = [
      { name: "config.yaml", data: Buffer.from(stampConfigYaml(input), "utf8") },
      { name: "README.txt", data: Buffer.from(packReadme(input, hasBinary, binaryNote), "utf8") },
    ]
    if (input.platform === "windows") {
      files.push({ name: "install.ps1", data: Buffer.from(windowsInstallPs1(hasBinary), "utf8") })
    } else {
      files.push({ name: "install.sh", data: Buffer.from(unixInstallSh(hasBinary), "utf8") })
    }
    if (binary) files.push({ name: binaryName, data: binary })
    if (helper) files.push({ name: helperName(input.platform), data: helper })
    const zip = await zipBuffers(files)
    const destDir = dataPath("packs")
    await fsp.mkdir(destDir, { recursive: true })
    const notes = [
      input.notes?.trim(),
      hasBinary ? `includes agent binary (${binaryNote})` : "config and installer only",
      hasHelper ? `includes helper binary (${helperNote})` : "",
    ]
      .filter(Boolean)
      .join(" — ")
    const row = await prisma.agentBuild.create({
      data: {
        platform: input.platform,
        arch: input.arch,
        path: path.join(destDir, "pending.zip"),
        notes,
      },
    })
    const dest = path.join(destDir, `${row.id}.zip`)
    await fsp.writeFile(dest, zip)
    const saved = await prisma.agentBuild.update({ where: { id: row.id }, data: { path: dest } })
    const signed = signedPackUrl(saved.id)
    return {
      build: { ...saved, size: zip.length, hasBinary, hasHelper },
      downloadUrl: signed.path,
      downloadUrlAbsolute: signed.url,
      expiresAt: signed.exp,
    }
  })

  app.delete(`${API_PREFIX}/admin/builder/packs/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const pack = await prisma.agentBuild.findUnique({ where: { id } })
    if (!pack) return reply.code(404).send(errorBody("not_found"))
    await fsp.unlink(pack.path).catch(() => undefined)
    await prisma.agentBuild.delete({ where: { id } })
    return { ok: true }
  })

  app.post(`${API_PREFIX}/admin/builder/compile`, async (req, reply) => {
    if (!env.enableAgentCompile) {
      return reply.code(501).send(errorBody("compile_disabled", { hint: "ENABLE_AGENT_COMPILE=1" }))
    }
    const parsed = compileRequestSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const started = await compileQueue.start(parsed.data)
    if (!started.ok) {
      return reply.code(started.status).send(errorBody(started.error, started.details))
    }
    return started.job
  })

  app.get(`${API_PREFIX}/admin/builder/compile`, async (_req, reply) => {
    const job = compileQueue.latest()
    if (!job) return reply.code(404).send(errorBody("not_found"))
    return job
  })

  app.get(`${API_PREFIX}/admin/builder/compile/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = id === "latest" ? compileQueue.latest() : compileQueue.get(id)
    if (!job) return reply.code(404).send(errorBody("not_found"))
    return job
  })

  app.get(`${API_PREFIX}/builder/download`, async (req, reply) => {
    const query = req.query as { id?: string; exp?: string; sig?: string }
    if (!query.id || !query.exp || !query.sig) return reply.code(400).send(errorBody("missing_params"))
    if (!verifyUpdateToken(query.id, Number(query.exp), query.sig)) {
      return reply.code(403).send(errorBody("invalid_signature"))
    }
    const pack = await prisma.agentBuild.findUnique({ where: { id: query.id } })
    if (!pack || !(await pathExists(pack.path))) return reply.code(404).send(errorBody("not_found"))
    reply.header("content-type", "application/zip")
    reply.header("content-disposition", `attachment; filename="pc-manager-${pack.platform}-${pack.arch}.zip"`)
    return reply.send(fs.createReadStream(pack.path))
  })
}
