import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/hooks/use-auth"
import { createUser, fetchTeams, type Team } from "@/lib/auth-api"

const TEMP_PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"

function generateTempPassword(length = 12): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (n) => TEMP_PASSWORD_CHARS[n % TEMP_PASSWORD_CHARS.length]).join("")
}

/** Admin-only: create a login for someone joining the desk. There is no self-service sign-up --
 * this, plus the CLI seed script, are the only ways accounts get made. The temporary password is
 * handed off out of band (Slack, in person); the new user changes it from their own Settings tab. */
export function AddUserCard() {
  const { token } = useAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    fetchTeams(token)
      .then((fetched) => {
        setTeams(fetched)
        setTeamId((current) => current || (fetched[0] ? String(fetched[0].id) : ""))
      })
      .catch(() => setError("Could not load teams."))
  }, [token])

  const canSubmit = username.trim().length >= 3 && password.length >= 8 && teamId !== "" && !submitting

  async function submit() {
    if (!token || teamId === "") return
    setSubmitting(true)
    setError(null)
    setCreated(null)
    try {
      const user = await createUser(token, username.trim(), password, Number(teamId))
      setCreated(user.username)
      setUsername("")
      setPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the user.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Add a user</CardTitle>
        <CardDescription>Create a username and temporary password for someone joining the desk. They can change it once they sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-username">Username</Label>
            <Input id="new-user-username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} disabled={submitting} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-team">Team</Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger id="new-user-team" disabled={submitting || teams.length === 0}>
                <SelectValue>{(v: string) => teams.find((t) => String(t.id) === v)?.name ?? "Select a team"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={String(team.id)}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="new-user-password">Temporary password</Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setPassword(generateTempPassword())}
                disabled={submitting}
              >
                Generate
              </button>
            </div>
            <Input
              id="new-user-password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {created ? <p className="text-sm text-up">Created {created}. Share the password with them directly.</p> : null}
          <Button onClick={submit} disabled={!canSubmit} className="mt-1">
            {submitting ? <Spinner /> : null}
            Create user
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
