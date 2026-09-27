"use client"

import { Badge } from "@workspace/ui/components/badge"

export function StatusBadge({ status }: { status: string }) {
  if (status === "online" || status === "success") {
    return <Badge variant="default">{status}</Badge>
  }
  if (status === "failed" || status === "offline") {
    return <Badge variant="destructive">{status}</Badge>
  }
  if (status === "cancelled") {
    return <Badge variant="outline">{status}</Badge>
  }
  return <Badge variant="outline">{status}</Badge>
}
