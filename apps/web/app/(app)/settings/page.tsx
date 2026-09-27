import { SettingsPage } from "@/components/settings-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-medium">Settings</h1>
      <SettingsPage />
    </div>
  )
}
