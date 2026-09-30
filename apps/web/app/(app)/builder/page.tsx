import { BuilderPage } from "@/components/builder-page"
import { serverApi } from "@/lib/server-api"

export default async function Page() {
  const install = await serverApi<{ command: string }>("/api/v1/admin/config/install-command")
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Builder</h1>
        <p className="text-sm text-muted-foreground">Stamp and compile agent installers for the fleet.</p>
      </div>
      <BuilderPage installCommand={install?.command ?? ""} />
    </div>
  )
}
