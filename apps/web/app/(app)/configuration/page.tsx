import { ConfigPage } from "@/components/config-page"
import type { TunnelView } from "@/components/public-access"
import { serverApi } from "@/lib/server-api"

type Helper = {
  agentServiceName: string
  statusPort: number
  backoffSec: number
  probeIntervalSec: number
  failThreshold: number
  maxBackoffSec: number
  startupGraceSec: number
}

type ConfigResponse = {
  rules: string
  automations: string
  scanScopeText: string
  softwareRules: string
  helper: Helper
  installCommand: string
  publicUrl: string
  fileOnly: string[]
}

export default async function Page() {
  const [config, settings, tunnel] = await Promise.all([
    serverApi<ConfigResponse>("/api/v1/admin/config"),
    serverApi<{ settings: { agent: { pollIntervalSec: number; idleHeartbeatSec: number } } }>("/api/v1/admin/settings"),
    serverApi<{ tunnel: TunnelView }>("/api/v1/admin/tunnels"),
  ])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Saved values override the YAML files in git. Files stay the defaults for a fresh checkout.
        </p>
      </div>
      <ConfigPage initial={config} agent={settings?.settings.agent ?? null} tunnel={tunnel?.tunnel ?? null} />
    </div>
  )
}
