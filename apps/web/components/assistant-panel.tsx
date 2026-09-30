"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"

type Proposal = { action: string; name?: string; scriptName?: string }
type ProposeResponse = { model: string; proposal: Proposal | null; confirm: boolean; message: string }
type Session = { watermark: string; consent: boolean; privacyScreen: boolean; owner: string; timeoutMin: number; hasInvite: boolean }

export function AssistantPanel({ deviceId }: { deviceId: string }) {
  const queryClient = useQueryClient()
  const session = useQuery({
    queryKey: ["session-flags", deviceId],
    queryFn: () => api<{ session: Session }>(`/api/v1/admin/devices/${deviceId}/session`),
  })
  const [text, setText] = React.useState("refresh inventory")
  const [proposal, setProposal] = React.useState<ProposeResponse | null>(null)
  const [watermark, setWatermark] = React.useState("")
  const [owner, setOwner] = React.useState("")
  const propose = useMutation({
    mutationFn: () =>
      api<ProposeResponse>(`/api/v1/admin/devices/${deviceId}/assistant/propose`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: (data) => setProposal(data),
    onError: (error: Error) => toast.error(error.message),
  })
  const run = useMutation({
    mutationFn: (confirmed: boolean) =>
      api(`/api/v1/admin/devices/${deviceId}/assistant/run`, {
        method: "POST",
        body: JSON.stringify({ proposal: proposal?.proposal, confirmed }),
      }),
    onSuccess: () => toast.success("Command queued"),
    onError: (error: Error) => toast.error(error.message),
  })
  const saveFlags = useMutation({
    mutationFn: (rotateInvite: boolean) =>
      api<{ invite?: string }>(`/api/v1/admin/devices/${deviceId}/session`, {
        method: "PUT",
        body: JSON.stringify({
          watermark,
          owner,
          consent: true,
          privacyScreen: session.data?.session.privacyScreen ?? false,
          timeoutMin: session.data?.session.timeoutMin ?? 60,
          rotateInvite,
        }),
      }),
    onSuccess: (data) => {
      toast.success(data.invite ? `Invite token (copy now): ${data.invite}` : "Session flags saved")
      void queryClient.invalidateQueries({ queryKey: ["session-flags", deviceId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  React.useEffect(() => {
    if (!session.data) return
    setWatermark(session.data.session.watermark)
    setOwner(session.data.session.owner)
  }, [session.data])
  const flags = session.data?.session
  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Proposes an existing device command. Destructive actions stay queued until you confirm. If no model key is set, known phrases still work.
        </p>
        {flags?.watermark ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs tracking-wide text-muted-foreground">{flags.watermark}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Input value={text} onChange={(e) => setText(e.target.value)} className="max-w-md" />
          <Button variant="outline" onClick={() => propose.mutate()} disabled={propose.isPending}>
            Propose
          </Button>
          <Button
            onClick={() => run.mutate(true)}
            disabled={!proposal?.proposal || run.isPending || (proposal.confirm && false)}
          >
            Run
          </Button>
        </div>
        {proposal ? (
          <p className="text-sm">
            {proposal.model === "unset" ? "Model key is unset. " : null}
            {proposal.message} {proposal.proposal ? `Action: ${proposal.proposal.action}` : ""}
            {proposal.confirm ? " Confirmation required." : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Watermark" value={watermark} onChange={(e) => setWatermark(e.target.value)} className="max-w-xs" />
          <Input placeholder="Session owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="max-w-xs" />
          <Button variant="outline" onClick={() => saveFlags.mutate(false)} disabled={saveFlags.isPending}>
            Save session flags
          </Button>
          <Button variant="outline" onClick={() => saveFlags.mutate(true)} disabled={saveFlags.isPending}>
            New invite token
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Consent is stored with the flags. Privacy screen is a request flag only; it does not blank the Windows console. Media stays on WebRTC DTLS/SRTP.
          {flags?.privacyScreen ? " Privacy screen requested." : ""} {flags?.hasInvite ? " Invite token is set." : ""}
        </p>
      </CardContent>
    </Card>
  )
}
