import type { StampPackInput } from "./schemas.ts"

export function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

function yamlStringList(items: string[]): string {
  if (items.length === 0) return "[]"
  return `\n${items.map((item) => `  - ${yamlQuote(item)}`).join("\n")}`
}

/** Agent `config.yaml` body written into stamp packs. Keep in sync with apps/agent config.example.yaml. */
export function stampConfigYaml(input: StampPackInput): string {
  return [
    `server_url: ${yamlQuote(input.serverUrl)}`,
    `fallback_urls: ${yamlStringList(input.fallbackUrls)}`,
    `enrollment_secret: ${yamlQuote(input.enrollmentSecret)}`,
    `heartbeat_interval_sec: ${input.heartbeatIntervalSec}`,
    `idle_heartbeat_sec: ${input.idleHeartbeatSec}`,
    `watched_heartbeat_sec: ${input.watchedHeartbeatSec}`,
    `poll_interval_sec: ${input.pollIntervalSec}`,
    `screenshot_interval_sec: ${input.screenshotIntervalSec}`,
    `auto_restart_time: ${yamlQuote(input.autoRestartTime)}`,
    `status_port: 17890`,
    `sandbox_roots: ${yamlStringList(input.sandboxRoots)}`,
    `lightweight: true`,
    `enable_gpu: ${input.enableGpu}`,
    `enable_temps: ${input.enableTemps}`,
    `enable_plugins: ${input.enablePlugins}`,
    `enable_screenshot: ${input.enableScreenshot}`,
    `enable_webrtc: ${input.enableWebrtc}`,
    "",
  ].join("\n")
}
