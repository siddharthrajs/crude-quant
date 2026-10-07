import { LoginPage } from "@/components/auth/login-page"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/hooks/use-auth"
import type { ReactNode } from "react"

export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth()

  if (status === "checking") {
    return (
      <div className="dark flex min-h-screen w-full items-center justify-center bg-background text-foreground">
        <Spinner className="size-5" />
      </div>
    )
  }

  if (status === "signed-out") {
    return <LoginPage />
  }

  return <>{children}</>
}
