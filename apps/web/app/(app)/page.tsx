import { OverviewPage } from "@/components/overview-page"
import { operatorAuthHeaders } from "@/lib/api"

async function loadOverview() {
  const base = process.env.API_INTERNAL_URL ?? "http://localhost:4000"
  try {
    const res = await fetch(`${base}/api/v1/admin/overview`, {
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
  const initial = await loadOverview()
  return <OverviewPage initial={initial} />
}
