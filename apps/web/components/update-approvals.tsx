"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"

type Row = { id: string; kb: string; title: string; approval: string; rebootPolicy: string }

export function UpdateApprovals({ deviceId }: { deviceId: string }) {
  const queryClient = useQueryClient()
  const updates = useQuery({
    queryKey: ["win-updates", deviceId],
    queryFn: () => api<{ updates: Row[] }>(`/api/v1/admin/devices/${deviceId}/updates`),
  })
  const act = useMutation({
    mutationFn: (input: { id: string; approval: string }) =>
      api(`/api/v1/admin/devices/${deviceId}/updates/${input.id}`, {
        method: "POST",
        body: JSON.stringify({ approval: input.approval }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["win-updates", deviceId] }),
    onError: (error: Error) => toast.error(error.message),
  })
  const install = useMutation({
    mutationFn: () => api(`/api/v1/admin/devices/${deviceId}/updates/actions/install`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Approved updates queued")
      void queryClient.invalidateQueries({ queryKey: ["win-updates", deviceId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const rows = updates.data?.updates ?? []
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Approval state is stored in WindowsUpdate. Install queues only approved KBs inside the maintenance window.</p>
        <Button size="sm" variant="outline" onClick={() => install.mutate()} disabled={install.isPending}>
          Install approved
        </Button>
      </div>
      {rows.slice(0, 30).map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono">{row.kb || "—"}</span>
          <span className="max-w-md truncate">{row.title}</span>
          <span className="text-muted-foreground">{row.approval}</span>
          {row.approval === "pending" || row.approval === "deferred" || row.approval === "failed" ? (
            <Button size="sm" variant="outline" onClick={() => act.mutate({ id: row.id, approval: "approved" })}>
              Approve
            </Button>
          ) : null}
          {row.approval === "pending" || row.approval === "approved" ? (
            <Button size="sm" variant="outline" onClick={() => act.mutate({ id: row.id, approval: "deferred" })}>
              Defer
            </Button>
          ) : null}
        </div>
      ))}
      <a className="text-sm underline" href="/api/v1/admin/reports/updates.csv">
        Update CSV
      </a>
    </div>
  )
}
