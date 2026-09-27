"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { APP_NAME, APP_VERSION } from "@workspace/shared"
import { ModeToggle } from "@/components/mode-toggle"
import { api, storeSessionToken } from "@/lib/api"
import { APP_NAV } from "@/lib/nav"
import { Button } from "@workspace/ui/components/button"

export function AppSidebar() {
  const pathname = usePathname()
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<{ mode: string }>("/api/v1/admin/auth/status"),
    staleTime: 30_000,
  })

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/" />} size="lg">
              <img
                src="/icon-192.png"
                alt=""
                width={24}
                height={24}
                className="size-6 shrink-0 rounded-md"
              />
              <span>{APP_NAME}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Fleet</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {APP_NAV.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <p className="px-2 text-xs text-muted-foreground">v{APP_VERSION}</p>
        {status.data?.mode === "password" ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            onClick={() => {
              storeSessionToken(null)
              void api("/api/v1/admin/auth/logout", { method: "POST" })
                .catch(() => undefined)
                .finally(() => {
                  window.location.href = "/login"
                })
            }}
          >
            Sign out
          </Button>
        ) : null}
        <ModeToggle />
      </SidebarFooter>
    </Sidebar>
  )
}
