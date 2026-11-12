import { useId, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { searchStrategies, type StrategySuggestion } from "@/lib/strategy-codes"
import { fieldClass } from "./shared"

// A QH-code field with a suggestion list under it: type a name ("wti spread c2", "brent fly dec26") or part of a
// code and pick with the mouse or ↑ ↓ Enter; Esc closes the list. A code typed in full still works as is, and
// Enter with the list closed submits.

export function StrategyInput({
  value,
  onChange,
  onSubmit,
  suggestions,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (code: string) => void
  onSubmit: () => void
  suggestions: StrategySuggestion[]
  placeholder?: string
  className?: string
  "aria-label"?: string
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const hits = useMemo(() => (open ? searchStrategies(suggestions, value) : []), [open, suggestions, value])
  // The typed text is exactly a listed code: nothing left to suggest.
  const exact = hits.length === 1 && hits[0].code === value.trim().toUpperCase()
  const showing = open && hits.length > 0 && !exact
  const index = Math.min(active, hits.length - 1)

  const pick = (s: StrategySuggestion) => {
    onChange(s.code)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!showing) return setOpen(true)
      setActive((i) => (e.key === "ArrowDown" ? Math.min(hits.length - 1, i + 1) : Math.max(0, i - 1)))
    } else if (e.key === "Enter") {
      if (showing) {
        e.preventDefault()
        pick(hits[index])
      } else onSubmit()
    } else if (e.key === "Escape") {
      setOpen(false)
    } else if (e.key === "Tab" && showing && value.trim()) {
      pick(hits[index])
    }
  }

  return (
    <div className={cn("relative", className)}>
      <input
        className={cn(fieldClass, "w-full font-mono")}
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing ? `${listId}-${index}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showing && (
        <ul id={listId} role="listbox" className="absolute top-full left-0 z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {hits.map((s, i) => (
            <li
              key={s.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              // mousedown, not click: it lands before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1", i === index && "bg-accent text-accent-foreground")}
            >
              <span className="font-mono font-semibold">{s.code}</span>
              <span className="min-w-0 truncate text-muted-foreground">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
