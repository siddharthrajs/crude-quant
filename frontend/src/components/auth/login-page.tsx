import { useState, type FormEvent } from "react"
import { Eye, EyeOff } from "lucide-react"
import { CurveMotif } from "@/components/auth/curve-motif"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/hooks/use-auth"

const TICKER: { symbol: string; last: string; up: boolean }[] = [
  { symbol: "CL", last: "78.42", up: true },
  { symbol: "BZ", last: "82.17", up: true },
  { symbol: "RB", last: "2.301", up: false },
  { symbol: "HO", last: "2.548", up: true },
  { symbol: "NG", last: "2.874", up: false },
]

export function LoginPage() {
  const { signIn } = useAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signIn(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dark grid min-h-screen w-full bg-background text-foreground lg:grid-cols-2">
      <div className="relative hidden overflow-hidden border-r border-border bg-card lg:flex lg:flex-col lg:justify-between">
        <CurveMotif className="absolute inset-0 h-full w-full" />
        <div className="relative z-10 p-10">
          <h1 className="text-xl font-semibold tracking-tight">Crude Quant</h1>
          <p className="mt-1.5 max-w-[26ch] text-sm text-muted-foreground">
            Forward curves, spreads, and quotes for the crude desk.
          </p>
        </div>
        <div className="relative z-10 flex items-center gap-5 border-t border-border/70 bg-background/60 px-10 py-4 backdrop-blur-sm">
          {TICKER.map((row) => (
            <div key={row.symbol} className="flex items-baseline gap-1.5 text-xs">
              <span className="font-medium text-muted-foreground">{row.symbol}</span>
              <span className="tabular-nums" data-numeric>
                {row.last}
              </span>
              <span className={row.up ? "text-up" : "text-down"}>{row.up ? "▲" : "▼"}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-8 p-6">
        <div className="flex flex-col items-center gap-1 lg:hidden">
          <h1 className="text-lg font-semibold tracking-tight">Crude Quant</h1>
          <p className="text-sm text-muted-foreground">Sign in to the desk</p>
        </div>

        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your desk credentials to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={submitting}
                    required
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={submitting}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={submitting} className="mt-1">
                {submitting ? <Spinner /> : null}
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
