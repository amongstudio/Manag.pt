import { InventoryPage } from "@/components/inventory-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Software</h1>
        <p className="text-sm text-muted-foreground">Fleet query against Software and SoftwareInstallation, not command blobs.</p>
      </div>
      <InventoryPage />
    </div>
  )
}
