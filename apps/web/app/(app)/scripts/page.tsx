import { ScriptsPage } from "@/components/scripts-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Scripts</h1>
        <p className="text-sm text-muted-foreground">
          Library scripts run through the existing agent <span className="font-mono">run_script</span> command.
        </p>
      </div>
      <ScriptsPage />
    </div>
  )
}
