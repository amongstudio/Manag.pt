import assert from "node:assert/strict"
import { mkdtemp, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  detectToolTarget,
  officialToolUrl,
  sha256Hex,
  stageVerifiedBytes,
  tunnelToolAsset,
  TUNNEL_TOOL_TARGETS,
  TUNNEL_TOOL_VERSIONS,
  type InstallableTunnelTool,
} from "./tunnel-tools.ts"

const TOOLS: InstallableTunnelTool[] = ["ngrok", "cloudflared", "zrok"]

test("tunnel tool URLs are pinned https downloads from the official host", () => {
  assert.equal(TUNNEL_TOOL_VERSIONS.ngrok, "3.39.11")
  assert.equal(TUNNEL_TOOL_VERSIONS.cloudflared, "2026.9.3")
  assert.equal(TUNNEL_TOOL_VERSIONS.zrok, "2.0.7")
  assert.equal(detectToolTarget("linux", "x64"), "linux-amd64")
  assert.equal(detectToolTarget("linux", "arm64"), "linux-arm64")
  assert.equal(detectToolTarget("win32", "x64"), "windows-amd64")
  assert.equal(detectToolTarget("darwin", "arm64"), null)
  for (const tool of TOOLS) {
    for (const target of TUNNEL_TOOL_TARGETS) {
      const asset = tunnelToolAsset(tool, target)
      assert.equal(officialToolUrl(asset.url), true)
      assert.match(asset.sha256, /^[a-f0-9]{64}$/)
      assert.equal(asset.url.startsWith("https://"), true)
    }
  }
  const ngrok = tunnelToolAsset("ngrok", "linux-amd64")
  assert.equal(ngrok.url, "https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz")
  const cloudflared = tunnelToolAsset("cloudflared", "linux-arm64")
  assert.equal(cloudflared.url, "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-arm64")
  const zrok = tunnelToolAsset("zrok", "windows-amd64")
  assert.equal(zrok.url, "https://github.com/openziti/zrok/releases/download/v2.0.7/zrok_2.0.7_windows_amd64.tar.gz")
  assert.equal(officialToolUrl("http://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"), false)
  assert.equal(officialToolUrl("https://example.com/ngrok.tgz"), false)
})

test("a matching checksum keeps the file and a mismatch deletes it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pcmanager-tool-test-"))
  const file = path.join(dir, "fixture.bin")
  const bytes = Buffer.from("pcmanager-tunnel-fixture")
  const good = await stageVerifiedBytes(file, bytes, sha256Hex(bytes))
  assert.equal(good.ok, true)
  await access(file)
  const bad = await stageVerifiedBytes(file, bytes, "0".repeat(64))
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.equal(bad.error, "checksum_mismatch")
  await assert.rejects(access(file))
})
