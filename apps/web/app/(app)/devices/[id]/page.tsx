import { DeviceDetail } from "@/components/device-detail"
import { serverApi } from "@/lib/server-api"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const inventory = await serverApi<Record<string, unknown>>(`/api/v1/admin/devices/${id}/inventory`)
  return <DeviceDetail id={id} initialInventory={inventory} />
}
