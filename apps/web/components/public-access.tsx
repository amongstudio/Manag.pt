"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"

const PROVIDERS = [
  { value: "ngrok", label: "Ngrok" },
  { value: "cloudflare", label: "Cloudflare Tunnel" },
  { value: "localtunnel", label: "LocalTunnel" },
  { value: "zrok", label: "zrok" },
  { value: "pinggy", label: "Pinggy" },
] as const

type Provider = (typeof PROVIDERS)[number]["value"]

type TunnelView = {
  provider: Provider
  status: "stopped" | "starting" | "up" | "error"
  publicUrl: string
  apiPublicUrl: string
  lastError: string
  startedAt: string | null
  exposeApi: boolean
  subdomain: string
  localtunnelHost: string
  webPort: number
  apiPort: number
  enabled: boolean
  retryCount: number
  secretsSet: {
    ngrokAuthtoken: boolean
    cloudflareToken: boolean
    pinggyToken: boolean
    zrokToken: boolean
  }
  install: Record<Provider, string>
  available: Record<Provider, boolean>
  commands: { dashboard: string; api: string }
  note: string
}

const TOKEN_KEY = {
  ngrok: "ngrokAuthtoken",
  cloudflare: "cloudflareToken",
  pinggy: "pinggyToken",
  zrok: "zrokToken",
} as const

function isProvider(value: string): value is Provider {
  return PROVIDERS.some((item) => item.value === value)
}

function payload(input: {
  provider: Provider
  exposeApi: boolean
  subdomain: string
  localtunnelHost: string
  webPort: string
  apiPort: string
  token: string
}) {
  const body: Record<string, string | number | boolean> = {
    provider: input.provider,
    exposeApi: input.exposeApi,
    subdomain: input.subdomain.trim(),
    localtunnelHost: input.localtunnelHost.trim() || "https://localtunnel.me",
    webPort: Number(input.webPort),
    apiPort: Number(input.apiPort),
  }
  if (input.provider !== "localtunnel" && input.token.trim()) {
    body[TOKEN_KEY[input.provider]] = input.token.trim()
  }
  return body
}

export function PublicAccess() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["tunnel"],
    queryFn: () => api<{ tunnel: TunnelView }>("/api/v1/admin/tunnels"),
    refetchInterval: (q) => {
      const status = q.state.data?.tunnel.status
      return status === "starting" || status === "up" ? 2000 : false
    },
  })
  const tunnel = query.data?.tunnel
  const [provider, setProvider] = React.useState<Provider>("ngrok")
  const [token, setToken] = React.useState("")
  const [subdomain, setSubdomain] = React.useState("")
  const [host, setHost] = React.useState("https://localtunnel.me")
  const [exposeApi, setExposeApi] = React.useState(false)
  const [webPort, setWebPort] = React.useState("3000")
  const [apiPort, setApiPort] = React.useState("4000")
  const hydrated = React.useRef(false)

  React.useEffect(() => {
    if (!tunnel || hydrated.current) return
    setProvider(tunnel.provider)
    setSubdomain(tunnel.subdomain)
    setHost(tunnel.localtunnelHost)
    setExposeApi(tunnel.exposeApi)
    setWebPort(String(tunnel.webPort))
    setApiPort(String(tunnel.apiPort))
    hydrated.current = true
  }, [tunnel])

  const body = payload({ provider, exposeApi, subdomain, localtunnelHost: host, webPort, apiPort, token })
  const save = useMutation({
    mutationFn: () => api<{ tunnel: TunnelView }>("/api/v1/admin/tunnels", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setToken("")
      toast.success("Saved")
      void client.invalidateQueries({ queryKey: ["tunnel"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const start = useMutation({
    mutationFn: () => api<{ tunnel: TunnelView }>("/api/v1/admin/tunnels/start", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      setToken("")
      toast.success(result.tunnel.publicUrl ? "Tunnel is up" : "Tunnel starting")
      void client.invalidateQueries({ queryKey: ["tunnel"] })
    },
    onError: (error: Error) => {
      toast.error(error.message)
      void client.invalidateQueries({ queryKey: ["tunnel"] })
    },
  })
  const stop = useMutation({
    mutationFn: () => api<{ tunnel: TunnelView }>("/api/v1/admin/tunnels/stop", { method: "POST" }),
    onSuccess: () => {
      toast.success("Tunnel stopped")
      void client.invalidateQueries({ queryKey: ["tunnel"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const available = tunnel?.available[provider]
  const install = tunnel?.install[provider] ?? ""
  const tokenSaved =
    provider === "ngrok"
      ? tunnel?.secretsSet.ngrokAuthtoken
      : provider === "cloudflare"
        ? tunnel?.secretsSet.cloudflareToken
        : provider === "pinggy"
          ? tunnel?.secretsSet.pinggyToken
          : provider === "zrok"
            ? tunnel?.secretsSet.zrokToken
            : false

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("Copied")
    } catch {
      toast.error("Could not copy")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Public access</CardTitle>
          <CardDescription>
            One dashboard tunnel at a time. The dashboard proxies <span className="font-mono">/api</span> to the API, so the web port is usually enough. An optional second tunnel publishes the API port. The operator token is still required. A tunnel does not bypass login and does not change scan authorization.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Setup for each provider is in{" "}
            <Link href="/docs/users/public-access" className="underline">
              Public access
            </Link>
            . This API does not download tunnel binaries.
          </p>
          <label className="text-sm">
            Provider
            <Select
              items={PROVIDERS.map((item) => ({ value: item.value, label: item.label }))}
              value={provider}
              onValueChange={(value) => {
                if (value && isProvider(String(value))) setProvider(String(value) as Provider)
              }}
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PROVIDERS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          {provider !== "localtunnel" ? (
            <label className="text-sm">
              {provider === "ngrok"
                ? "Authtoken"
                : provider === "cloudflare"
                  ? "Named tunnel token"
                  : provider === "pinggy"
                    ? "Pinggy token"
                    : "zrok token"}
              <Input
                className="mt-1"
                type="password"
                autoComplete="off"
                value={token}
                placeholder={tokenSaved ? "Saved token stays if this is blank" : "Optional"}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
          ) : null}
          {provider === "zrok" ? (
            <p className="text-xs text-muted-foreground">
              Run <span className="font-mono">zrok enable</span> in a shell before Start. This API stores the token and does not run enable, so the token is not written to process logs.
            </p>
          ) : null}
          {provider === "cloudflare" ? (
            <p className="text-xs text-muted-foreground">
              Leave the token blank for a trycloudflare.com quick tunnel. A named token runs <span className="font-mono">cloudflared tunnel run --token</span>. The hostname then comes from Cloudflare, and the API-port toggle does not open a second process.
            </p>
          ) : null}
          {provider === "localtunnel" || provider === "zrok" ? (
            <label className="text-sm">
              Subdomain
              <Input className="mt-1" value={subdomain} placeholder="optional, lowercase" onChange={(event) => setSubdomain(event.target.value)} />
            </label>
          ) : null}
          {provider === "localtunnel" ? (
            <label className="text-sm">
              LocalTunnel host
              <Input className="mt-1" value={host} onChange={(event) => setHost(event.target.value)} />
            </label>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              Web port
              <Input className="mt-1" inputMode="numeric" value={webPort} onChange={(event) => setWebPort(event.target.value)} />
            </label>
            <label className="text-sm">
              API port
              <Input className="mt-1" inputMode="numeric" value={apiPort} onChange={(event) => setApiPort(event.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={exposeApi} onCheckedChange={setExposeApi} />
            Also expose API port
          </label>
          <p className="text-xs text-muted-foreground">Upstream is always 127.0.0.1. Blank token fields keep the saved secret. Saved secrets are not returned by the API.</p>
          {tunnel && available === false ? (
            <div className="rounded-md border border-dashed p-3">
              <p className="text-sm">This provider is not available on the API host. Install it, then start the tunnel. The API will not download it for you.</p>
              <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">{install}</pre>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={available === false || start.isPending} onClick={() => start.mutate()}>
              Start
            </Button>
            <Button type="button" variant="outline" disabled={tunnel?.status === "stopped" || stop.isPending} onClick={() => stop.mutate()}>
              Stop
            </Button>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>{tunnel?.note}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>
            <span className="text-muted-foreground">State </span>
            {tunnel?.status ?? "…"}
            {tunnel?.startedAt ? <span className="text-muted-foreground"> · started {formatWhen(tunnel.startedAt)}</span> : null}
            {tunnel?.retryCount ? <span className="text-muted-foreground"> · retries {tunnel.retryCount}</span> : null}
          </p>
          {tunnel?.lastError ? <p className="text-destructive">{tunnel.lastError}</p> : null}
          <UrlRow label="Dashboard URL" value={tunnel?.publicUrl ?? ""} onCopy={copy} />
          {tunnel?.exposeApi ? <UrlRow label="API URL" value={tunnel.apiPublicUrl} onCopy={copy} /> : null}
          {tunnel?.commands.dashboard ? (
            <pre className="overflow-auto rounded-md border p-3 text-xs">{tunnel.commands.dashboard}</pre>
          ) : null}
          {tunnel?.commands.api ? <pre className="overflow-auto rounded-md border p-3 text-xs">{tunnel.commands.api}</pre> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function UrlRow({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value || "—"}</span>
      <Button type="button" size="sm" variant="outline" disabled={!value} onClick={() => onCopy(value)}>
        Copy
      </Button>
    </div>
  )
}
