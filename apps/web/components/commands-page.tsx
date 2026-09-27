"use client"

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { TerminalIcon } from "lucide-react"
import { toast } from "sonner"
import { COMMAND_TYPES, DESTRUCTIVE_COMMANDS, validateCommandPayload, type CommandType } from "@workspace/shared"

import { api, formatWhen, snippet } from "@/lib/api"
import { BulkProgressLabel } from "@/lib/bulk-command-progress"
import { CommandComposer } from "@/components/command-composer"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group"

const PAGE_SIZE = 50
const ROW_H = 52

type Row = {
  id: string
  type: string
  status: string
  hostname: string
  deviceId: string
  createdAt: string
  result: unknown
  payload?: Record<string, unknown>
}

type CommandsResponse = { commands: Row[]; nextCursor: string | null }

function isDestructive(type: string): boolean {
  return DESTRUCTIVE_COMMANDS.has(type as CommandType)
}

export function CommandsPage() {
  const client = useQueryClient()
  const [status, setStatus] = React.useState("all")
  const [resultRow, setResultRow] = React.useState<Row | null>(null)
  const [retryRow, setRetryRow] = React.useState<Row | null>(null)
  const [saveRow, setSaveRow] = React.useState<Row | null>(null)
  const [saveName, setSaveName] = React.useState("")
  const [saveDescription, setSaveDescription] = React.useState("")
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const query = useInfiniteQuery({
    queryKey: ["commands", status],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_SIZE))
      if (status !== "all") params.set("status", status)
      if (pageParam) params.set("cursor", pageParam)
      return api<CommandsResponse>(`/api/v1/admin/commands?${params}`)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const rows = query.data?.pages.flatMap((page) => page.commands) ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/commands/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Cancelled")
      void client.invalidateQueries({ queryKey: ["commands"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const retry = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/commands/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Queued retry")
      setRetryRow(null)
      void client.invalidateQueries({ queryKey: ["commands"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const saveTpl = useMutation({
    mutationFn: () => {
      if (!saveRow) throw new Error("No command selected")
      if (!(COMMAND_TYPES as readonly string[]).includes(saveRow.type)) {
        throw new Error(`Unknown command type ${saveRow.type}`)
      }
      const type = saveRow.type as CommandType
      const payload = saveRow.payload ?? {}
      const checked = validateCommandPayload(type, payload)
      if (!checked.ok) throw new Error(checked.error.issues.map((i) => i.message).join("; ") || "invalid payload")
      return api("/api/v1/admin/command-templates", {
        method: "POST",
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDescription.trim() || undefined,
          type,
          payload: checked.payload,
        }),
      })
    },
    onSuccess: () => {
      toast.success("Template saved")
      setSaveRow(null)
      void client.invalidateQueries({ queryKey: ["command-templates"] })
    },
    onError: (e) => toast.error(e.message),
  })

  function requestRetry(row: Row) {
    if (isDestructive(row.type)) {
      setRetryRow(row)
      return
    }
    retry.mutate(row.id)
  }

  const virtualItems = virtualizer.getVirtualItems()
  const renderedItems =
    virtualItems.length > 0 ? virtualItems : rows.map((_, index) => ({ index }))
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <ToggleGroup
          className="md:ml-auto"
          value={[status]}
          onValueChange={(value) => setStatus(value[0] ?? "all")}
          spacing={2}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="pending">Pending</ToggleGroupItem>
          <ToggleGroupItem value="running">Running</ToggleGroupItem>
          <ToggleGroupItem value="success">Success</ToggleGroupItem>
          <ToggleGroupItem value="failed">Failed</ToggleGroupItem>
          <ToggleGroupItem value="cancelled">Cancelled</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <CommandComposer deviceIds={[]} triggerLabel="Bulk command" showProgress={false} allowFleet />
          <BulkProgressLabel />
        </div>
      </div>
      {query.isError && query.data ? (
        <QueryErrorBanner cached error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.isError && !query.data ? (
        <QueryErrorState title="Commands unavailable" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading && !rows.length ? (
        <Skeleton className="h-64" />
      ) : !rows.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TerminalIcon />
            </EmptyMedia>
            <EmptyTitle>No commands queued</EmptyTitle>
            <EmptyDescription>Use bulk command to target every enrolled agent.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div ref={setScrollEl} className="relative min-h-24 max-h-[min(70vh,40rem)] overflow-auto rounded-lg border">
            <table className="w-full caption-bottom text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky top-0 z-10 bg-background">When</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Device</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Type</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Result</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background" />
                </TableRow>
              </TableHeader>
              <tbody>
                {paddingTop > 0 ? (
                  <tr>
                    <td colSpan={6} style={{ height: paddingTop }} />
                  </tr>
                ) : null}
                {renderedItems.map((virtualRow) => {
                  const row = rows[virtualRow.index]
                  if (!row) return null
                  return (
                    <TableRow key={row.id} data-index={virtualRow.index} ref={virtualizer.measureElement}>
                      <TableCell>{formatWhen(row.createdAt)}</TableCell>
                      <TableCell>{row.hostname}</TableCell>
                      <TableCell>{row.type}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="max-w-[12rem] overflow-hidden">
                        {row.result != null ? (
                          <button
                            type="button"
                            className="block w-full truncate text-left text-xs text-muted-foreground"
                            onClick={() => setResultRow(row)}
                          >
                            {snippet(row.result)}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex flex-nowrap justify-end gap-1">
                          {row.status === "pending" ? (
                            <Button size="sm" variant="outline" onClick={() => cancel.mutate(row.id)}>
                              Cancel
                            </Button>
                          ) : null}
                          {row.status === "failed" || row.status === "cancelled" ? (
                            <Button size="sm" variant="outline" onClick={() => requestRetry(row)}>
                              Retry
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSaveName(row.type.replaceAll("_", " "))
                              setSaveDescription("")
                              setSaveRow(row)
                            }}
                          >
                            Save as template
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {paddingBottom > 0 ? (
                  <tr>
                    <td colSpan={6} style={{ height: paddingBottom }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {query.hasNextPage ? (
            <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              Load more
            </Button>
          ) : null}
        </>
      )}
      <Dialog open={!!resultRow} onOpenChange={(open) => !open && setResultRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{resultRow?.type}</DialogTitle>
            <DialogDescription>
              {resultRow?.hostname} · {resultRow?.status}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
            {resultRow ? JSON.stringify(resultRow.result, null, 2) : ""}
          </pre>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!saveRow}
        onOpenChange={(open) => {
          if (!open) setSaveRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>
              {saveRow?.type} · stores type and payload for the composer gallery.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cmd-tpl-name">Name</FieldLabel>
              <Input id="cmd-tpl-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="cmd-tpl-desc">Description</FieldLabel>
              <Input id="cmd-tpl-desc" value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveRow(null)}>
              Cancel
            </Button>
            <Button onClick={() => saveTpl.mutate()} disabled={saveTpl.isPending || !saveName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!retryRow} onOpenChange={(open) => !open && setRetryRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry {retryRow?.type}?</AlertDialogTitle>
            <AlertDialogDescription>
              This queues the same destructive command on {retryRow?.hostname ?? "the device"} again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => retryRow && retry.mutate(retryRow.id)}
            >
              Retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
