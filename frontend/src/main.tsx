import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './components/auth/auth-gate'
import { TooltipProvider } from './components/ui/tooltip'
import { AuthProvider } from './hooks/use-auth'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <TooltipProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </TooltipProvider>
    </AuthProvider>
  </StrictMode>,
)
