import Link from "next/link"

import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

export default function Page() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Legacy plugins are disabled</CardTitle>
        <CardDescription>
          Arbitrary script and binary uploads were replaced by the signed,
          approval-gated module library.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button render={<Link href="/modules" />}>Open module library</Button>
      </CardContent>
    </Card>
  )
}
