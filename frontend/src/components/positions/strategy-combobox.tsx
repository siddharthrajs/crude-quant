import { useEffect, useRef, useState } from "react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import type { Leg } from "@/lib/strategy-resolver"

export interface StrategyOption {
  key: string
  /** "X26 1MF" for a standard tenor+code strategy; the structure's own label for a custom one. */
  label: string
  legs: Leg[]
  tenor: string | null
  code: string
  isCustom: boolean
}

export interface StrategyComboboxProps {
  options: StrategyOption[]
  value: StrategyOption | null
  onChange: (option: StrategyOption) => void
  disabled?: boolean
  id?: string
}

/** Type-to-filter over every live tenor+strategy combination for the chosen product (cmdk's own
 * fuzzy match on each option's "X26 1MF"-style label), plus the user's custom curve structures. */
export function StrategyCombobox({ options, value, onChange, disabled, id }: StrategyComboboxProps) {
  const [open, setOpen] = useState(false)
  // Free-typing buffer: null once a pick lands or nothing's been typed since, so the field then just
  // shows `value`'s own label -- derived, not synced from the `value` prop via an effect.
  const [typed, setTyped] = useState<string | null>(null)
  const query = typed ?? value?.label ?? ""
  const containerRef = useRef<HTMLDivElement>(null)

  // Closing without a pick (outside click or Escape) drops the free-typing buffer too, so the field
  // reverts to showing `value`'s own label instead of leftover, unresolved search text.
  function close() {
    setOpen(false)
    setTyped(null)
  }

  useEffect(() => {
    if (!open) return
    function onDocPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener("pointerdown", onDocPointerDown)
    return () => document.removeEventListener("pointerdown", onDocPointerDown)
  }, [open])

  const standard = options.filter((o) => !o.isCustom)
  const custom = options.filter((o) => o.isCustom)

  function pick(option: StrategyOption) {
    onChange(option)
    setTyped(null)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <Command className="size-auto overflow-visible rounded-lg bg-transparent p-0">
        <CommandInput
          id={id}
          value={query}
          onValueChange={(v) => {
            setTyped(v)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close()
          }}
          placeholder={disabled ? "Pick a product first" : "Search tenor + strategy, e.g. X26 1MF"}
          disabled={disabled}
          className="h-8"
        />
        {open && !disabled && (
          <CommandList className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
            <CommandEmpty>No matching strategy.</CommandEmpty>
            {standard.length > 0 && (
              <CommandGroup heading="Standard">
                {standard.map((o) => (
                  <CommandItem key={o.key} value={o.label} onSelect={() => pick(o)}>
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {custom.length > 0 && (
              <CommandGroup heading="Custom strategies">
                {custom.map((o) => (
                  <CommandItem key={o.key} value={o.label} onSelect={() => pick(o)}>
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        )}
      </Command>
    </div>
  )
}
