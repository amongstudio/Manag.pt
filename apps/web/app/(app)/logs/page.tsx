import { LogsPage } from "@/components/logs-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Logs</h1>
        <p className="text-sm text-muted-foreground">Inspect agent log batches as they arrive.</p>
      </div>
      <LogsPage />
    </div>
  )
}
