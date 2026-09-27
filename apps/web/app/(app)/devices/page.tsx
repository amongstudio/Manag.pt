import { Suspense } from "react"

import { DevicesPage } from "@/components/devices-page"
import { operatorAuthHeaders } from "@/lib/api"
import { Skeleton } from "@workspace/ui/components/skeleton"

async function loadDevices() {
  const base = process.env.API_INTERNAL_URL ?? "http://localhost:4000"
  try {
    const res = await fetch(`${base}/api/v1/admin/devices`, {
      cache: "no-store",
      headers: operatorAuthHeaders(),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export default async function Page() {
  const initial = await loadDevices()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Devices</h1>
        <p className="text-sm text-muted-foreground">Search the fleet, filter by status, and run bulk actions.</p>
      </div>
      <Suspense fallback={<Skeleton className="h-64" />}>
        <DevicesPage initial={initial} />
      </Suspense>
    </div>
  )
}
