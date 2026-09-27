import { PluginsPage } from "@/components/plugins-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Plugins</h1>
        <p className="text-sm text-muted-foreground">Upload plugins and run them on enrolled agents.</p>
      </div>
      <PluginsPage />
    </div>
  )
}
