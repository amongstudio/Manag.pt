import { SecurityPage } from "@/components/security-page"

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Security</h1>
        <p className="text-sm text-muted-foreground">
          Scanner orchestration for networks listed in scan-scope.yaml. No exploit payloads are sent.
        </p>
      </div>
      <SecurityPage />
    </div>
  )
}
