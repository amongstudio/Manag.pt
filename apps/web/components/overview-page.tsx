"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ActivityIcon, MonitorIcon, TriangleAlertIcon } from "lucide-react"

import { api, formatWhen } from "@/lib/api"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type OverviewAlert = {
  id: string
  type: string
  title: string
  body: string
  status: string
  deviceId: string | null
  hostname: string | null
  createdAt: string
}

type Overview = {
  devices: number
  online: number
  offline: number
  pendingAlerts: number
  activity: Array<{
    id: string
    type: string
    status: string
    hostname: string
    deviceId: string
    createdAt: string
  }>
  alerts?: OverviewAlert[]
}

type OnlineDevice = { id: string; hostname: string }

export function OverviewPage({ initial }: { initial?: Overview | null }) {
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/v1/admin/overview"),
    initialData: initial ?? undefined,
  })
  const onlineNow = useQuery({
    queryKey: ["devices", "", "online"],
    queryFn: () => api<{ devices: OnlineDevice[] }>("/api/v1/admin/devices?status=online"),
    staleTime: 30_000,
  })
  const data = query.data
  const [dismissed, setDismissed] = React.useState<string[]>([])
  const alerts = (data?.alerts ?? []).filter((row) => !dismissed.includes(row.id))
  const onlineHosts = (onlineNow.data?.devices ?? []).slice(0, 8)

  if (query.isError && !data) {
    return (
      <QueryErrorState title="Overview unavailable" error={query.error} onRetry={() => void query.refetch()} />
    )
  }

  if (query.isLoading && !data) {
    return (
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {query.isError ? (
        <QueryErrorBanner cached error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard href="/devices?status=online" title="Online" description="Agents currently heartbeating">
          {data?.online ?? 0}
        </KpiCard>
        <KpiCard href="/devices?status=offline" title="Offline" description="Missed heartbeat window">
          {data?.offline ?? 0}
        </KpiCard>
        <KpiCard href="/devices" title="Fleet" description="Enrolled devices">
          {data?.devices ?? 0}
        </KpiCard>
        <KpiCard href="/devices" title="Alerts" description="Pending Telegram/Discord/SMTP rows">
          <span className="flex items-center gap-2">
            {data?.pendingAlerts ?? 0}
            {(data?.pendingAlerts ?? 0) > 0 ? <Badge variant="destructive">queued</Badge> : null}
          </span>
        </KpiCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Online now</CardTitle>
            <CardDescription>Up to eight agents currently heartbeating</CardDescription>
          </CardHeader>
          <CardContent>
            {!onlineHosts.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MonitorIcon />
                  </EmptyMedia>
                  <EmptyTitle>No agents online</EmptyTitle>
                  <EmptyDescription>Online hostnames appear here as they heartbeat.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {onlineHosts.map((device) => (
                  <li key={device.id}>
                    <Link
                      href={`/devices/${device.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {device.hostname}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>Live alerts; open the device when an agent is attached</CardDescription>
            </div>
            {alerts.length ? (
              <Button size="sm" variant="ghost" onClick={() => setDismissed((cur) => [...cur, ...alerts.map((a) => a.id)])}>
                Dismiss all
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {!alerts.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TriangleAlertIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing waiting</EmptyTitle>
                  <EmptyDescription>Offline, heartbeat, command failure, and kill-switch events appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {alerts.slice(0, 8).map((row) => (
                  <li key={row.id}>
                    <div className="flex items-start justify-between gap-2 rounded-lg px-1 py-1.5 hover:bg-muted/50">
                      {row.deviceId ? (
                        <Link href={`/devices/${row.deviceId}`} className="min-w-0 flex-1">
                          <AlertSummary row={row} />
                        </Link>
                      ) : (
                        <div className="min-w-0 flex-1">
                          <AlertSummary row={row} />
                        </div>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setDismissed((cur) => [...cur, row.id])}>
                        Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Recent command queue</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.activity?.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ActivityIcon />
                </EmptyMedia>
                <EmptyTitle>No activity yet</EmptyTitle>
                <EmptyDescription>Commands will appear here as you queue them.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.activity.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={`/devices/${row.deviceId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.hostname}
                      </Link>
                    </TableCell>
                    <TableCell>{row.type}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>{formatWhen(row.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {(data?.devices ?? 0) === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MonitorIcon />
            </EmptyMedia>
            <EmptyTitle>No agents enrolled</EmptyTitle>
            <EmptyDescription>
              Install the Go agent with ENROLLMENT_SECRET matching the API. Keep this dashboard on a private network,
              VPN, or IP allowlist.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {(data?.pendingAlerts ?? 0) > 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Notifications waiting</EmptyTitle>
            <EmptyDescription>Configure Telegram, Discord, or SMTP under Settings so queued alerts can send.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </div>
  )
}

function KpiCard({
  href,
  title,
  description,
  children,
}: {
  href: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:bg-muted/40">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="text-2xl font-medium">{children}</CardContent>
      </Card>
    </Link>
  )
}

function AlertSummary({ row }: { row: OverviewAlert }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{row.title}</span>
      <span className="text-sm text-muted-foreground">{row.hostname ?? "No device"}</span>
    </div>
  )
}
