import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/hooks/use-auth"

/** Self-service: change your own username and/or password. Requires the current password to authorize either change. */
export function AccountSettingsCard() {
  const { user, updateAccount } = useAuth()
  const [username, setUsername] = useState(user?.username ?? "")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const usernameChanged = username.trim() !== user?.username
  const passwordMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const canSubmit =
    currentPassword.length > 0 &&
    (usernameChanged || newPassword.length > 0) &&
    !passwordMismatch &&
    (newPassword.length === 0 || newPassword.length >= 8) &&
    !submitting

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setSubmitting(true)
    try {
      await updateAccount({
        currentPassword,
        newUsername: usernameChanged ? username.trim() : undefined,
        newPassword: newPassword.length > 0 ? newPassword : undefined,
      })
      setSuccess("Account updated.")
      setNewPassword("")
      setConfirmPassword("")
      setCurrentPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update your account.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Your account</CardTitle>
        <CardDescription>Change your username or password.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-username">Username</Label>
            <Input id="account-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={submitting} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-new-password">New password</Label>
            <Input
              id="account-new-password"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep your current password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-confirm-password">Confirm new password</Label>
            <Input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={passwordMismatch}
            />
            {passwordMismatch ? <p className="text-xs text-destructive">Passwords don't match.</p> : null}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <Label htmlFor="account-current-password">Current password</Label>
            <Input
              id="account-current-password"
              type="password"
              autoComplete="current-password"
              placeholder="Required to save changes"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {success ? <p className="text-sm text-up">{success}</p> : null}
          <Button type="submit" disabled={!canSubmit} className="mt-1">
            {submitting ? <Spinner /> : null}
            Save changes
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
