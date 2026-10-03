/**
 * Download pinned tunnel clients into the API data directory.
 * Checksums are verified before the file is marked executable.
 * Nothing here starts a tunnel.
 */

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import zlib from "node:zlib"

import { dataPath } from "./env.js"

const execFileAsync = promisify(execFile)

export const TUNNEL_TOOL_VERSIONS = {
  ngrok: "3.39.11",
  cloudflared: "2026.9.3",
  zrok: "2.0.7",
} as const

export const TUNNEL_TOOL_TARGETS = ["linux-amd64", "linux-arm64", "windows-amd64"] as const
export type TunnelToolTarget = (typeof TUNNEL_TOOL_TARGETS)[number]
export type InstallableTunnelTool = "ngrok" | "cloudflared" | "zrok"

const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024

type ToolFormat = "binary" | "tgz" | "zip"

type ToolAsset = {
  url: string
  sha256: string
  format: ToolFormat
  fileName: string
  member: string
}

const ASSETS: Record<InstallableTunnelTool, Record<TunnelToolTarget, ToolAsset>> = {
  ngrok: {
    "linux-amd64": {
      url: "https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz",
      sha256: "cec0b4997fcc5f529dfc74bac89050354d11a915f968720600039738fdf330cf",
      format: "tgz",
      fileName: "ngrok",
      member: "ngrok",
    },
    "linux-arm64": {
      url: "https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz",
      sha256: "3b6ba05a9d9585c34157fa0819fa95cdb13839f5b506b9e63204705cf7f79e29",
      format: "tgz",
      fileName: "ngrok",
      member: "ngrok",
    },
    "windows-amd64": {
      url: "https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip",
      sha256: "699bbf1932ec43a573b764bd03e6568efa2c4e45955eb3cc2089c19bb4be4464",
      format: "zip",
      fileName: "ngrok.exe",
      member: "ngrok.exe",
    },
  },
  cloudflared: {
    "linux-amd64": {
      url: "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64",
      sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
      format: "binary",
      fileName: "cloudflared",
      member: "cloudflared",
    },
    "linux-arm64": {
      url: "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-arm64",
      sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
      format: "binary",
      fileName: "cloudflared",
      member: "cloudflared",
    },
    "windows-amd64": {
      url: "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-windows-amd64.exe",
      sha256: "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2",
      format: "binary",
      fileName: "cloudflared.exe",
      member: "cloudflared.exe",
    },
  },
  zrok: {
    "linux-amd64": {
      url: "https://github.com/openziti/zrok/releases/download/v2.0.7/zrok_2.0.7_linux_amd64.tar.gz",
      sha256: "1266f1d338d8ed229a37acd07e42b8434142d1f3af861fcdc94434d7d5b4154f",
      format: "tgz",
      fileName: "zrok",
      member: "zrok2",
    },
    "linux-arm64": {
      url: "https://github.com/openziti/zrok/releases/download/v2.0.7/zrok_2.0.7_linux_arm64.tar.gz",
      sha256: "75d253a4174e06c28e1568cd8bff5820f4d1b8a510caa81f7f6676df46bb1c04",
      format: "tgz",
      fileName: "zrok",
      member: "zrok2",
    },
    "windows-amd64": {
      url: "https://github.com/openziti/zrok/releases/download/v2.0.7/zrok_2.0.7_windows_amd64.tar.gz",
      sha256: "5741570ddd73d5a2b409ab8b4dc6af2d3e06cafbb4cad216efecd141e74a39de",
      format: "tgz",
      fileName: "zrok.exe",
      member: "zrok2.exe",
    },
  },
}

const REDIRECT_HOSTS = new Set([
  "bin.ngrok.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
])

export function tunnelToolsDir(): string {
  return dataPath("tools")
}

export function detectToolTarget(platform = process.platform, arch = process.arch): TunnelToolTarget | null {
  if (arch !== "x64" && arch !== "arm64") return null
  if (platform === "linux" && arch === "x64") return "linux-amd64"
  if (platform === "linux" && arch === "arm64") return "linux-arm64"
  if (platform === "win32" && arch === "x64") return "windows-amd64"
  return null
}

export function tunnelToolAsset(tool: InstallableTunnelTool, target: TunnelToolTarget): ToolAsset {
  return ASSETS[tool][target]
}

export function officialToolUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  if (parsed.hostname === "bin.ngrok.com") return parsed.pathname.startsWith("/c/")
  if (parsed.hostname !== "github.com") return false
  return (
    parsed.pathname.startsWith("/cloudflare/cloudflared/releases/download/") ||
    parsed.pathname.startsWith("/openziti/zrok/releases/download/")
  )
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Write bytes, compare sha256, and delete the file when the hash does not match. */
export async function stageVerifiedBytes(
  file: string,
  bytes: Uint8Array,
  expectedSha256: string
): Promise<{ ok: true } | { ok: false; error: "checksum_mismatch" }> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes, { mode: 0o600 })
  const onDisk = await readFile(file)
  if (sha256Hex(onDisk) !== expectedSha256.toLowerCase()) {
    await unlink(file).catch(() => undefined)
    return { ok: false, error: "checksum_mismatch" }
  }
  return { ok: true }
}

function allowedRedirectHost(hostname: string): boolean {
  return REDIRECT_HOSTS.has(hostname)
}

async function downloadOfficial(startUrl: string): Promise<Buffer> {
  if (!officialToolUrl(startUrl)) throw new Error("unofficial_url")
  let url = startUrl
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || !allowedRedirectHost(parsed.hostname)) throw new Error("unofficial_url")
    if (hop === 0 && !officialToolUrl(url)) throw new Error("unofficial_url")
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")
      if (!location) throw new Error("download_failed")
      url = new URL(location, url).toString()
      continue
    }
    if (!res.ok || !res.body) throw new Error("download_failed")
    const chunks: Buffer[] = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      total += step.value.byteLength
      if (total > MAX_DOWNLOAD_BYTES) throw new Error("download_too_large")
      chunks.push(Buffer.from(step.value))
    }
    return Buffer.concat(chunks)
  }
  throw new Error("download_failed")
}

function safeMember(member: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(member)
}

async function extractTarMember(archive: string, member: string): Promise<Buffer> {
  if (!safeMember(member)) throw new Error("bad_archive_member")
  const dir = path.join(tmpdir(), `pcmanager-tool-${createHash("sha256").update(archive).digest("hex").slice(0, 12)}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", dir, member], { shell: false, timeout: 60_000 })
    return await readFile(path.join(dir, member))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function zipEntry(buf: Buffer, member: string): Buffer {
  if (!safeMember(member)) throw new Error("bad_archive_member")
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > buf.length) throw new Error("bad_zip")
  let cursor = buf.readUInt32LE(eocd + 16)
  while (cursor + 46 <= buf.length && buf.readUInt32LE(cursor) === 0x02014b50) {
    const method = buf.readUInt16LE(cursor + 10)
    const compSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOff = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8")
    if (name === member) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("bad_zip")
      const localName = buf.readUInt16LE(localOff + 26)
      const localExtra = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + localName + localExtra
      const data = buf.subarray(start, start + compSize)
      if (data.length !== compSize) throw new Error("bad_zip")
      if (method === 0) return Buffer.from(data)
      if (method === 8) return zlib.inflateRawSync(data)
      throw new Error("bad_zip")
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  throw new Error("bad_zip")
}

export async function installTunnelTool(
  tool: InstallableTunnelTool,
  toolsDir = tunnelToolsDir(),
  platform = process.platform,
  arch = process.arch
): Promise<{ ok: true; bin: string; version: string } | { ok: false; error: string }> {
  const target = detectToolTarget(platform, arch)
  if (!target) return { ok: false, error: "unsupported_platform" }
  const asset = tunnelToolAsset(tool, target)
  if (!officialToolUrl(asset.url)) return { ok: false, error: "unofficial_url" }
  await mkdir(toolsDir, { recursive: true })
  const partial = path.join(toolsDir, `.${asset.fileName}.partial`)
  const finalPath = path.join(toolsDir, asset.fileName)
  try {
    const bytes = await downloadOfficial(asset.url)
    const staged = await stageVerifiedBytes(partial, bytes, asset.sha256)
    if (!staged.ok) return staged
    let payload = bytes
    if (asset.format === "tgz") payload = await extractTarMember(partial, asset.member)
    else if (asset.format === "zip") payload = zipEntry(bytes, asset.member)
    if (asset.format !== "binary") {
      await unlink(partial).catch(() => undefined)
      const stagedBin = await stageVerifiedBytes(partial, payload, sha256Hex(payload))
      if (!stagedBin.ok) return stagedBin
    }
    await chmod(partial, 0o755)
    await unlink(finalPath).catch(() => undefined)
    await rename(partial, finalPath)
    try {
      await access(finalPath, constants.X_OK)
    } catch {
      await unlink(finalPath).catch(() => undefined)
      return { ok: false, error: "install_failed" }
    }
    return { ok: true, bin: finalPath, version: TUNNEL_TOOL_VERSIONS[tool] }
  } catch {
    await unlink(partial).catch(() => undefined)
    return { ok: false, error: "install_failed" }
  }
}
