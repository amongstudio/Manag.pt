"use client"

import type { ReactNode } from "react"

import { AppHeader } from "@/components/app-header"
import { AppSidebar } from "@/components/app-sidebar"
import { AuthGate } from "@/components/auth-gate"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

export default function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AppHeader />
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </AuthGate>
  )
}
