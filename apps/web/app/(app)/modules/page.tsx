import { ModulesPage } from "@/components/modules-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Module library</h1>
        <p className="text-sm text-muted-foreground">
          Register, approve, grant, run, and revoke signed tools.
        </p>
      </div>
      <ModulesPage />
    </div>
  )
}
