import { AlertsPage } from "@/components/alerts-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Alerts</h1>
        <p className="text-sm text-muted-foreground">Socket notifications, including metric rules from config/rules.yaml.</p>
      </div>
      <AlertsPage />
    </div>
  )
}
