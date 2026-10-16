import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/hooks/use-auth"
import { deleteUsers, fetchTeams, fetchUsers, type AuthUser, type Role, type Team } from "@/lib/auth-api"

const ROLE_LABELS: Record<Role, string> = { admin: "Admin", manager: "Manager", member: "Member" }

/** Admin-only: every account, with multi-select delete. Deleting needs the admin's own password and
 * also removes the deleted users' trades, journals and watchlists; you can't delete yourself. */
export function ManageUsersCard() {
  const { user: me, token } = useAuth()
  const [users, setUsers] = useState<AuthUser[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(() => {
    if (!token) return
    Promise.all([fetchUsers(token), fetchTeams(token)])
      .then(([u, t]) => {
        setUsers(u)
        setTeams(t)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load users."))
  }, [token])

  useEffect(load, [load])

  function toggle(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function openDialog() {
    setDialogError(null)
    setOpen(true)
  }

  async function confirmDelete(e: FormEvent) {
    e.preventDefault()
    if (!token) return
    setDeleting(true)
    setDialogError(null)
    try {
      await deleteUsers(token, [...selected])
      setNotice(`Deleted ${selected.size} ${selected.size === 1 ? "account" : "accounts"}.`)
      setSelected(new Set())
      setOpen(false)
      load()
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Could not delete the selected accounts.")
    } finally {
      setDeleting(false)
    }
  }

  const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? `Team ${id}`
  const names = users.filter((u) => selected.has(u.id)).map((u) => u.username)

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>All users</CardTitle>
        <CardDescription>Every account on the platform. Select accounts to delete them.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-8 py-1.5" />
                <th className="py-1.5 font-normal">Username</th>
                <th className="py-1.5 font-normal">Account type</th>
                <th className="py-1.5 font-normal">Team</th>
                <th className="py-1.5 font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me?.id
                return (
                  <tr key={u.id} className="border-b border-border last:border-b-0">
                    <td className="py-1.5">
                      <Checkbox
                        aria-label={`Select ${u.username}`}
                        checked={selected.has(u.id)}
                        disabled={isMe}
                        onCheckedChange={(c) => toggle(u.id, c === true)}
                      />
                    </td>
                    <td className="py-1.5 font-semibold">
                      {u.username}
                      {isMe ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span> : null}
                    </td>
                    <td className="py-1.5">
                      <Badge variant="secondary">{ROLE_LABELS[u.role]}</Badge>
                    </td>
                    <td className="py-1.5">{teamName(u.team_id)}</td>
                    <td className="py-1.5 text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="text-sm text-up">{notice}</p> : null}
          <div className="flex items-center gap-2">
            <Button variant="destructive" size="sm" disabled={selected.size === 0} onClick={openDialog}>
              Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => !deleting && setOpen(o)}>
        <DialogContent>
          <form onSubmit={confirmDelete} className="flex flex-col gap-3">
            <DialogHeader>
              <DialogTitle>
                Delete {selected.size} {selected.size === 1 ? "account" : "accounts"}?
              </DialogTitle>
              <DialogDescription>
                {names.join(", ")}. This permanently removes the accounts along with their positions, trade journals and watchlists. It can't be undone.
              </DialogDescription>
            </DialogHeader>
            {dialogError ? <p className="text-sm text-destructive">{dialogError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={deleting} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={deleting}>
                {deleting ? <Spinner /> : null}
                Delete permanently
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
