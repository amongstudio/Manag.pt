"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { Spinner } from "@workspace/ui/components/spinner"

type AuthStatus = { mode: "open" | "token" | "password"; needsSetup: boolean }

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<AuthStatus>("/api/v1/admin/auth/status"),
    staleTime: 15_000,
  })
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api<{ username: string; method: string }>("/api/v1/admin/auth/me"),
    retry: false,
    enabled: status.data?.mode === "password",
  })

  React.useEffect(() => {
    if (status.data?.mode === "password" && me.isError) {
      router.replace("/login")
    }
  }, [me.isError, router, status.data?.mode])

  if (status.data?.mode === "password" && (me.isPending || me.isError)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Spinner className="size-5" />
      </div>
    )
  }
  return <>{children}</>
}
