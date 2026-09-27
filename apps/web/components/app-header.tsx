"use client"

import * as React from "react"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useQuery } from "@tanstack/react-query"

import { CommandPalette } from "@/components/command-palette"
import { ConnectionIndicator } from "@/components/connection-indicator"
import { api } from "@/lib/api"
import { readLastDevice, writeLastDevice } from "@/lib/last-device"
import { APP_NAV, navLabelForPath } from "@/lib/nav"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import { Separator } from "@workspace/ui/components/separator"
import { SidebarTrigger } from "@workspace/ui/components/sidebar"

function deviceIdFromPath(pathname: string, paramId?: string): string | undefined {
  if (typeof paramId === "string" && paramId) return paramId
  const match = pathname.match(/^\/devices\/([^/]+)/)
  return match?.[1]
}

export function AppHeader() {
  const pathname = usePathname() ?? "/"
  const params = useParams<{ id?: string }>()
  const deviceId = deviceIdFromPath(pathname, params.id)
  const isDevicePage = Boolean(deviceId)
  const list = useQuery({
    queryKey: ["devices", "", "all"],
    queryFn: () => api<{ devices: Array<{ id: string; hostname: string }> }>("/api/v1/admin/devices"),
    enabled: isDevicePage,
    staleTime: 30_000,
  })
  const [cachedName, setCachedName] = React.useState<string>()
  const hostname = (deviceId && list.data?.devices.find((row) => row.id === deviceId)?.hostname) || cachedName

  React.useEffect(() => {
    if (!deviceId) {
      setCachedName(undefined)
      return
    }
    const last = readLastDevice()
    if (last?.id === deviceId) setCachedName(last.hostname)
  }, [deviceId])

  React.useEffect(() => {
    if (!deviceId || !hostname) return
    writeLastDevice({ id: deviceId, hostname })
  }, [deviceId, hostname])

  const title = isDevicePage ? (hostname ?? "Device") : navLabelForPath(pathname)
  const crumbs = headerCrumbs(pathname, isDevicePage)

  return (
    <header className="flex h-12 items-center gap-2 border-b px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" />
      {crumbs ? (
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <React.Fragment key={crumb.href}>
                {index > 0 ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem>
                  {index === crumbs.length - 1 ? (
                    <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<Link href={crumb.href} />} className="truncate">
                      {crumb.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      ) : (
        <span className="truncate text-sm text-muted-foreground">{title}</span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <CommandPalette />
        <ConnectionIndicator />
      </div>
    </header>
  )
}

function headerCrumbs(
  pathname: string,
  isDevicePage: boolean
): Array<{ href: string; label: string }> | null {
  if (isDevicePage) return null
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const crumbs: Array<{ href: string; label: string }> = [{ href: "/", label: "Overview" }]
  let href = ""
  for (const part of parts) {
    href += `/${part}`
    const nav = APP_NAV.find((item) => item.href === href)
    crumbs.push({ href, label: nav?.label ?? decodeURIComponent(part) })
  }
  return crumbs
}
