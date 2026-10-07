// Decorative forward-curve line art for the sign-in hero panel. Two static
// curves (contango-shaped, like the desk's own CL/BZ forward curves) plus a
// faint grid, echoing the product's actual subject matter instead of a
// generic gradient.

export function CurveMotif({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 400" fill="none" className={className} aria-hidden="true">
      <defs>
        <filter id="curve-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="curve-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {Array.from({ length: 9 }, (_, i) => (
        <line key={`v${i}`} x1={i * 75} y1="0" x2={i * 75} y2="400" stroke="var(--color-border)" strokeWidth="1" opacity="0.35" />
      ))}
      {Array.from({ length: 7 }, (_, i) => (
        <line key={`h${i}`} x1="0" y1={i * 66.7} x2="600" y2={i * 66.7} stroke="var(--color-border)" strokeWidth="1" opacity="0.35" />
      ))}

      <path d="M20,360 C140,340 220,300 300,255 S460,150 580,95 L580,400 L20,400 Z" fill="url(#curve-fade)" />

      <path
        d="M20,300 C130,282 210,258 300,232 S470,188 580,168"
        stroke="var(--color-chart-2)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.65"
      />

      <path
        d="M20,360 C140,340 220,300 300,255 S460,150 580,95"
        stroke="var(--color-primary)"
        strokeWidth="2.5"
        strokeLinecap="round"
        filter="url(#curve-glow)"
      />
      <circle cx="580" cy="95" r="4.5" fill="var(--color-primary)" />
      <circle cx="580" cy="95" r="4.5" fill="var(--color-primary)" className="animate-ping opacity-60" style={{ transformOrigin: "580px 95px" }} />
    </svg>
  )
}
