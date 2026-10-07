import { cn } from "cn"
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react"
import { createPortal } from "react-dom"
import { Input } from "@/components/ui/input"
import { HotkeyScope, useMaybeHotkeys } from "@/hooks/use-hotkeys"
import type { Popout } from "@/hooks/use-popout"
import { cycleLinkGroup, type LinkGroup, type LinkGroupId } from "@/lib/link-group"

// The frame around one thing on a trading screen: a book, a chart, a blotter.
//
// A panel is a hotkey scope, so its keys and its palette actions come with it: `kind="book"` is the
// scope `panel:book`, shared by every book on the screen, and the book with focus is the one that
// answers. The header is a drag handle for whatever lays panels out, and the things in it that take
// a click keep that click from starting a drag.

interface PanelContextValue {
  titleId: string
}

const PanelContext = createContext<PanelContextValue | null>(null)

// The layout around a panel listens for one of these on the header to start a drag.
const keepFromDrag = { onPointerDown: stop, onMouseDown: stop, onTouchStart: stop }

function stop(event: SyntheticEvent) {
  event.stopPropagation()
}

export type PanelState = "error" | "drag-target" | "active" | "inactive" | "auto"

export interface PanelProps extends Omit<ComponentProps<"div">, "ref"> {
  /** The kind of panel, `book` or `chart`. It is the hotkey scope `panel:<kind>`, shared by every instance. */
  kind: string
  /** Draw the active border. Left out, the panel is active while focus is inside it. */
  active?: boolean
  /** Something is being dragged over this panel. */
  dragTarget?: boolean
  /** Draw the error border. It outranks the other two. */
  error?: boolean
}

export function Panel({ kind, active, dragTarget = false, error = false, className, children, ...props }: PanelProps) {
  const titleId = useId()
  const state: PanelState = error ? "error" : dragTarget ? "drag-target" : active === undefined ? "auto" : active ? "active" : "inactive"
  return (
    <PanelContext.Provider value={{ titleId }}>
      <HotkeyScope
        role="region"
        aria-labelledby={props["aria-label"] ? undefined : titleId}
        {...props}
        scope={`panel:${kind}`}
        data-slot="tradecn-panel"
        data-kind={kind}
        data-state={state}
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground outline-none lining-nums tabular-nums",
          "data-[state=active]:border-panel-active data-[state=auto]:focus-within:border-panel-active",
          "data-[state=drag-target]:border-panel-drag-target data-[state=drag-target]:bg-panel-drag-target/10",
          "data-[state=error]:border-panel-error",
          className,
        )}
      >
        {children}
      </HotkeyScope>
    </PanelContext.Provider>
  )
}

/** The strip along the top, and the handle a layout drags the panel by: aim it at `[data-panel-handle]`. */
export function PanelHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-panel-handle="" className={cn("flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 text-xs select-none", className)} {...props} />
}

/** Names the panel, to the eye and to a screen reader. */
export function PanelTitle({ className, ...props }: ComponentProps<"div">) {
  const panel = useContext(PanelContext)
  return <div id={panel?.titleId} className={cn("truncate font-medium", className)} {...props} />
}

/** Your buttons, pushed to the far end of the header. A press on one does not start a drag. */
export function PanelActions({ className, ...props }: ComponentProps<"div">) {
  return <div {...keepFromDrag} className={cn("ml-auto flex items-center gap-0.5", className)} {...props} />
}

export function PanelContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />
}

export interface SymbolTagProps {
  value: string | null
  /** Enter on a draft that is not blank and not what is already showing. */
  onCommit: (symbol: string) => void
  /** Trims and upper-cases by default. Pass your own for symbols where case matters. */
  normalize?: (raw: string) => string
  /** False refuses the draft: the field stays open and marks itself invalid. */
  validate?: (symbol: string) => boolean
  /** Shown while there is no symbol. */
  placeholder?: string
  /** Controlled edit mode, for a hotkey that opens the field. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  disabled?: boolean
  label?: string
  className?: string
}

const defaultNormalize = (raw: string) => raw.trim().toUpperCase()

/**
 * The panel's symbol. Click it, or press Enter on it, to type another: Enter commits, Escape and
 * clicking away put it back. When the symbol changes and it was not typed here, the tag rings once
 * in `panel-sync`, which is how a panel says it followed its link group.
 */
export function SymbolTag({ value, onCommit, normalize = defaultNormalize, validate, placeholder = "symbol", editing: editingProp, onEditingChange, disabled = false, label = "Symbol", className }: SymbolTagProps) {
  const [ownEditing, setOwnEditing] = useState(false)
  const editing = (editingProp ?? ownEditing) && !disabled
  const [draft, setDraft] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [wasEditing, setWasEditing] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // Set by the keyboard exits, so focus goes back to the tag and stays in the panel's scope. Clicking away keeps the click's focus.
  const refocus = useRef(false)
  // The field is open and has not been left yet. Some engines blur an input as it is removed, and that must not count as clicking away.
  const open = useRef(false)
  const typedHere = useRef(value)

  // Opened from outside (a hotkey): start from what is showing, same as a click.
  if (editing !== wasEditing) {
    setWasEditing(editing)
    if (editing) {
      setDraft(value ?? "")
      setInvalid(false)
    }
  }

  function setEditing(next: boolean) {
    if (editingProp === undefined) setOwnEditing(next)
    onEditingChange?.(next)
  }

  function leave(restoreFocus: boolean) {
    if (!open.current) return
    open.current = false
    refocus.current = restoreFocus
    setEditing(false)
  }

  function commit() {
    const next = normalize(draft)
    if (!next || next === value) return leave(true)
    if (validate && !validate(next)) return setInvalid(true)
    typedHere.current = next
    onCommit(next)
    leave(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" && event.key !== "Escape") return
    // Claimed, so a hotkey dispatcher listening further out leaves it alone.
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Enter") commit()
    else leave(true)
  }

  useLayoutEffect(() => {
    if (editing) {
      open.current = true
      input.current?.focus()
      input.current?.select()
    } else if (refocus.current) {
      refocus.current = false
      button.current?.focus()
    }
  }, [editing])

  useLayoutEffect(() => {
    if (typedHere.current === value) return
    typedHere.current = value
    const el = root.current
    if (!el || typeof el.animate !== "function") return
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return
    el.animate([{ boxShadow: "0 0 0 1px var(--panel-sync)" }, { boxShadow: "0 0 0 1px transparent" }], { duration: 900, easing: "ease-out" })
  }, [value])

  return (
    <span ref={root} {...keepFromDrag} data-symbol-tag="" data-editing={editing} className={cn("inline-flex h-5 items-center rounded-sm font-(family-name:--tradecn-font-mono) text-xs", className)}>
      {editing ? (
        <Input
          ref={input}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => leave(false)}
          aria-label={label}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          className="h-5 w-24 rounded-sm px-1 py-0 font-(family-name:--tradecn-font-mono) text-xs md:text-xs"
        />
      ) : (
        <button
          ref={button}
          type="button"
          disabled={disabled}
          aria-label={value ? `${label} ${value}, change` : `${label}, none, set`}
          onClick={() => setEditing(true)}
          className={cn("h-5 rounded-sm px-1 font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none", !value && "font-normal text-muted-foreground")}
        >
          {value ?? placeholder}
        </button>
      )}
    </span>
  )
}

const LINK_CLASS: Record<LinkGroupId, string> = {
  1: "bg-link-1",
  2: "bg-link-2",
  3: "bg-link-3",
  4: "bg-link-4",
}

export interface LinkGroupDotProps extends Omit<ComponentProps<"button">, "onChange" | "children"> {
  group: LinkGroup
  /** Click moves to the next group, Shift+click to the one before. */
  onGroupChange: (group: LinkGroup) => void
}

/** Which link group the panel is in, as a color and a number, because color is never the only channel. */
export function LinkGroupDot({ group, onGroupChange, className, onClick, ...props }: LinkGroupDotProps) {
  const name = group === null ? "Not linked" : `Link group ${group}`
  return (
    <button
      type="button"
      {...keepFromDrag}
      aria-label={`${name}, change`}
      title={name}
      data-link-group={group ?? "none"}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-xs leading-none font-semibold text-black/85 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        group === null ? "border border-dashed border-muted-foreground/60" : LINK_CLASS[group],
        className,
      )}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) onGroupChange(cycleLinkGroup(group, event.shiftKey ? -1 : 1))
      }}
    >
      {group}
    </button>
  )
}

export interface PanelPopoutProps {
  /** From `usePopout()`. */
  popout: Popout
  /** What the page shows in the panel's place while it is out. */
  placeholder?: ReactNode
  children?: ReactNode
}

/**
 * Renders its children in the page or in the popout's window, wherever `popout` says, without
 * remounting them. Inside a `HotkeysProvider` the popout's document gets the same keys.
 */
export function PanelPopout({ popout, placeholder, children }: PanelPopoutProps) {
  const { slotRef, isOpen, host, window: popoutWindow } = popout
  const hotkeys = useMaybeHotkeys()
  const target = popoutWindow?.document
  useEffect(() => (hotkeys && target ? hotkeys.attach(target) : undefined), [hotkeys, target])
  return (
    <>
      <div ref={slotRef} className="contents" />
      {isOpen ? placeholder : null}
      {host ? createPortal(children, host) : null}
    </>
  )
}
