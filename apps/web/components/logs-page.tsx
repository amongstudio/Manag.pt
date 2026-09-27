"use client"

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useInfiniteQuery } from "@tanstack/react-query"
import { ScrollTextIcon } from "lucide-react"

import { api, formatWhen } from "@/lib/api"
import { useDebouncedValue } from "@/lib/hooks"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

const LEVELS = [
  { label: "All levels", value: null },
  { label: "DEBUG", value: "DEBUG" },
  { label: "INFO", value: "INFO" },
  { label: "WARNING", value: "WARNING" },
  { label: "ERROR", value: "ERROR" },
]

const PAGE_SIZE = 50
const ROW_H = 44

type LogRow = {
  id: string
  hostname: string
  level: string
  source: string | null
  message: string
  timestamp: string
}

type LogsResponse = { logs: LogRow[]; nextCursor: string | null }

export function LogsPage() {
  const [level, setLevel] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState("")
  const debouncedSearch = useDebouncedValue(search, 300)
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const query = useInfiniteQuery({
    queryKey: ["logs", level, debouncedSearch],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_SIZE))
      if (level) params.set("level", level)
      if (debouncedSearch) params.set("search", debouncedSearch)
      if (pageParam) params.set("cursor", pageParam)
      return api<LogsResponse>(`/api/v1/admin/logs?${params}`)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const rows = query.data?.pages.flatMap((page) => page.logs) ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 16,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup className="md:flex-row">
        <Field>
          <FieldLabel>Level</FieldLabel>
          <Select items={LEVELS} value={level} onValueChange={(v) => setLevel((v as string | null) ?? null)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LEVELS.map((item) => (
                  <SelectItem key={String(item.value)} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="log-search">Search</FieldLabel>
          <Input id="log-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="message contains" />
        </Field>
      </FieldGroup>
      {query.isError && query.data ? (
        <QueryErrorBanner cached error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.isError && !query.data ? (
        <QueryErrorState title="Logs unavailable" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading && !rows.length ? (
        <Skeleton className="h-64" />
      ) : !rows.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>No logs</EmptyTitle>
            <EmptyDescription>Agents POST batches to /api/v1/agent/logs.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div ref={setScrollEl} className="relative max-h-[min(70vh,40rem)] overflow-auto rounded-lg border">
            <table className="w-full caption-bottom text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky top-0 z-10 bg-background">When</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Device</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Level</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-background">Message</TableHead>
                </TableRow>
              </TableHeader>
              <tbody>
                {paddingTop > 0 ? (
                  <tr>
                    <td colSpan={4} style={{ height: paddingTop }} />
                  </tr>
                ) : null}
                {virtualItems.map((virtualRow) => {
                  const row = rows[virtualRow.index]
                  if (!row) return null
                  return (
                    <TableRow key={row.id} data-index={virtualRow.index} ref={virtualizer.measureElement}>
                      <TableCell>{formatWhen(row.timestamp)}</TableCell>
                      <TableCell>{row.hostname}</TableCell>
                      <TableCell>{row.level}</TableCell>
                      <TableCell className="max-w-xl truncate">{row.message}</TableCell>
                    </TableRow>
                  )
                })}
                {paddingBottom > 0 ? (
                  <tr>
                    <td colSpan={4} style={{ height: paddingBottom }} />
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
    </div>
  )
}
