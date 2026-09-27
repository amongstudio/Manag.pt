"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { APP_NAME } from "@workspace/shared"
import { api, storeSessionToken } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"

type AuthStatus = { mode: "open" | "token" | "password"; needsSetup: boolean }

export function LoginPage() {
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<AuthStatus>("/api/v1/admin/auth/status"),
  })
  const [username, setUsername] = React.useState("operator")
  const [password, setPassword] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const setup = status.data?.needsSetup !== false && status.data?.mode !== "password"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    try {
      const path = setup ? "/api/v1/admin/auth/setup" : "/api/v1/admin/auth/login"
      const res = await api<{ token?: string }>(path, { method: "POST", body: JSON.stringify({ username, password }) })
      if (res.token) storeSessionToken(res.token)
      window.location.href = "/"
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed")
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{APP_NAME}</CardTitle>
          <CardDescription>
            {setup ? "Create the first operator password. This is stored in SQLite, not OPERATOR_TOKEN." : "Sign in to the fleet console."}
          </CardDescription>
        </CardHeader>
        <form onSubmit={(e) => void submit(e)}>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  id="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete={setup ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={pending || status.isPending}>
              {pending ? <Spinner className="size-4" /> : null}
              {setup ? "Create operator" : "Sign in"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
