import { CommandsPage } from "@/components/commands-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Commands</h1>
        <p className="text-sm text-muted-foreground">Compose a command for one device or the entire fleet.</p>
      </div>
      <CommandsPage />
    </div>
  )
}
