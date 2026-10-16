import { useEffect, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/hooks/use-auth"
import { fetchTeams, type Role } from "@/lib/auth-api"

const ROLE_LABELS: Record<Role, string> = { admin: "Admin", manager: "Manager", member: "Member" }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** Read-only summary of the signed-in user's account details. */
export function ProfileCard() {
  const { user, token } = useAuth()
  const [teamName, setTeamName] = useState<string | null>(null)

  useEffect(() => {
    if (!token || !user) return
    fetchTeams(token)
      .then((teams) => setTeamName(teams.find((t) => t.id === user.team_id)?.name ?? null))
      .catch(() => setTeamName(null))
  }, [token, user])

  if (!user) return null

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your account details.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl>
          <Field label="Username">
            <span className="font-semibold">{user.username}</span>
          </Field>
          <Field label="Account type">
            <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
          </Field>
          <Field label="Team">{teamName ?? `Team ${user.team_id}`}</Field>
          <Field label="Status">{user.is_active ? "Active" : "Inactive"}</Field>
          <Field label="Member since">
            {new Date(user.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
          </Field>
        </dl>
      </CardContent>
    </Card>
  )
}
