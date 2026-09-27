"use client"

import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"

export default function Error({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  reset?: () => void
  unstable_retry?: () => void
}) {
  React.useEffect(() => {
    console.error(error)
  }, [error])

  const retry = unstable_retry ?? reset

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Empty className="max-w-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>
            {error.message || "An unexpected error occurred while rendering this page."}
            {error.digest ? ` (digest ${error.digest})` : ""}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex gap-2">
          {retry ? (
            <Button onClick={() => retry()}>Try again</Button>
          ) : null}
          <Button variant="outline" onClick={() => window.location.assign("/")}>
            Back to overview
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
