"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Row = { deviceId: string; hostname: string; name: string; version: string; publisher: string; collectedAt: string }

export function InventoryPage() {
  const [name, setName] = React.useState("")
  const [version, setVersion] = React.useState("")
  const [query, setQuery] = React.useState({ name: "", version: "" })
  const software = useQuery({
    queryKey: ["software", query],
    queryFn: () => api<{ software: Row[] }>(`/api/v1/admin/software?name=${encodeURIComponent(query.name)}&version=${encodeURIComponent(query.version)}`),
  })
  const qs = `name=${encodeURIComponent(query.name)}&version=${encodeURIComponent(query.version)}`
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Name contains" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
        <Input placeholder="Version equals" value={version} onChange={(e) => setVersion(e.target.value)} className="max-w-xs" />
        <Button onClick={() => setQuery({ name, version })}>Filter</Button>
        <a className="self-center text-sm underline" href={`/api/v1/admin/reports/software.csv?${qs}`}>
          CSV
        </a>
        <a className="self-center text-sm underline" href={`/api/v1/admin/reports/software.html?${qs}`}>
          HTML
        </a>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Host</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Publisher</TableHead>
            <TableHead>Collected</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(software.data?.software ?? []).map((row) => (
            <TableRow key={`${row.deviceId}-${row.name}-${row.version}`}>
              <TableCell>{row.hostname}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.version}</TableCell>
              <TableCell>{row.publisher}</TableCell>
              <TableCell>{formatWhen(row.collectedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
