export type Platform = "mac" | "other"

/** `global` runs anywhere outside inputs. `editing` runs anywhere, inputs included. `panel:<id>` runs inside `[data-hotkey-scope="panel:<id>"]`. */
export type HotkeyScopeName = "global" | "editing" | `panel:${string}`

export type HotkeyHandler = (event: KeyboardEvent) => void

export interface HotkeyBinding {
  id: string
  /** `"mod+k"`, `"shift+/"`, `"?"`, or a chord of steps separated by spaces, `"g h"`. `mod` is ⌘ on a Mac and Ctrl elsewhere. `""` is unbound. */
  keys: string
  scope: HotkeyScopeName
  description: string
  /** A heading for overlays and palette rows. */
  group?: string
  /** Checked at keydown. False skips this binding and lets an outer scope answer. */
  when?: () => boolean
  /** Fire again while the key is held. Off by default: a held key should not cancel thirty orders. */
  repeat?: boolean
  /** On by default. */
  preventDefault?: boolean
}

export interface HotkeyEntry extends HotkeyBinding {
  /** The keys in force: the override when there is one, else the binding's own. */
  keys: string
  defaultKeys: string
  remapped: boolean
}

export interface HotkeyConflict {
  /** `duplicate`: same keys where both can fire. `prefix`: one is the start of the other's chord. `shadow`: a panel binding hides a global or editing one while focus is in that panel. */
  kind: "duplicate" | "prefix" | "shadow"
  /** The contested keys, normalized; for a prefix, the shorter of the two. */
  keys: string
  ids: [string, string]
}

/** Binding id to keys. What a consumer persists. */
export type HotkeyOverrides = Record<string, string>

export type HotkeyTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">

/** Limits a handler to events from inside one scope element, when the binding lives in that scope. */
export interface HandlerScope {
  scope: string
  element: () => Element | null
}

export interface HotkeyRegistryOptions {
  /** How long a chord waits for its next key. Default 1000. */
  chordTimeoutMs?: number
  platform?: Platform
}

export interface HotkeyRegistry {
  readonly platform: Platform
  /** Declare a binding, or replace the one with the same id. Returns the conflicts it takes part in. */
  register(binding: HotkeyBinding, handler?: HotkeyHandler): HotkeyConflict[]
  unregister(id: string): void
  /** Attach a handler to a declared (or not yet declared) binding. Returns the detach. A fenced handler can settle a conflict, so attaching and detaching wake `subscribe` as a declaration does. */
  bind(id: string, handler: HotkeyHandler, within?: HandlerScope | null): () => void
  /** Override a binding's keys; `""` unbinds it. Notifies `onChange`. Returns the conflicts the new keys take part in. */
  remap(id: string, keys: string): HotkeyConflict[]
  /** Drop one override, or all of them. Notifies `onChange`. */
  reset(id?: string): void
  /** Replace every override, from the consumer's persistence. Ids not declared yet apply when they are. Does not notify `onChange`. */
  load(overrides: HotkeyOverrides): void
  overrides(): HotkeyOverrides
  /** Overrides changed through `remap` or `reset`: the moment to persist. */
  onChange(cb: (overrides: HotkeyOverrides) => void): () => void
  /** Every binding with its keys in force. Stable array reference until a binding, an override, or a handler changes. */
  list(): readonly HotkeyEntry[]
  /** Every conflict the declarations leave standing once their handlers are read, against the document as it is now. A fresh array each call. */
  conflicts(): HotkeyConflict[]
  /** Wakes on any change to `list()` or `pending()`, and when a handler comes or goes. */
  subscribe(cb: () => void): () => void
  /** Listen for keydown on a target, `document` by default. Attaching the same target twice adds one listener. */
  attach(target?: HotkeyTarget): () => void
  /** The chord typed so far, normalized (`"g"`), or null. */
  pending(): string | null
  /** Run one event through the dispatcher. `attach` calls this; it is public for events forwarded from elsewhere. True when the event was consumed. */
  handle(event: KeyboardEvent): boolean
}

interface Step {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  pgup: "pageup",
  pgdn: "pagedown",
  plus: "+",
}

const CODE_KEYS: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
}

const IGNORED_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Dead", "Process", "Unidentified"])
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"])
const SCOPE_ATTR = "data-hotkey-scope"
const WALLS = '[role="dialog"], [role="alertdialog"]'

const MAC_LABELS = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
const OTHER_LABELS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" }
const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  space: "Space",
  tab: "Tab",
  backspace: "⌫",
  delete: "Del",
  insert: "Ins",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other"
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "") ? "mac" : "other"
}

function parseStep(part: string, platform: Platform): Step {
  const step: Step = { ctrl: false, alt: false, shift: false, meta: false, key: "" }
  for (const token of part.toLowerCase().split("+")) {
    if (token === "mod") step[platform === "mac" ? "meta" : "ctrl"] = true
    else if (token === "ctrl" || token === "control") step.ctrl = true
    else if (token === "alt" || token === "option" || token === "opt") step.alt = true
    else if (token === "shift") step.shift = true
    else if (token === "meta" || token === "cmd" || token === "command" || token === "win" || token === "super") step.meta = true
    else if (step.key) throw new Error(`hotkeys: "${part}" names two keys; separate the steps of a chord with a space`)
    else step.key = KEY_ALIASES[token] ?? token
  }
  if (!step.key) throw new Error(`hotkeys: "${part}" has no key (write the + key as "plus")`)
  return step
}

function parseKeys(keys: string, platform: Platform): Step[] {
  return keys.trim().split(/\s+/).filter(Boolean).map((part) => parseStep(part, platform))
}

function stepToString(step: Step): string {
  return [step.ctrl && "ctrl", step.alt && "alt", step.shift && "shift", step.meta && "meta", step.key].filter(Boolean).join("+")
}

/** Canonical form for comparing and storing: `mod` resolved, aliases folded, modifiers in one order. Throws on keys that do not parse. */
export function normalizeKeys(keys: string, platform: Platform = detectPlatform()): string {
  return parseKeys(keys, platform).map(stepToString).join(" ")
}

/** Key caps for shadcn's `Kbd`, one array per chord step: `"mod+k"` is `[["⌘", "K"]]` on a Mac and `[["Ctrl", "K"]]` elsewhere. */
export function formatKeys(keys: string, platform: Platform = detectPlatform()): string[][] {
  const labels = platform === "mac" ? MAC_LABELS : OTHER_LABELS
  return parseKeys(keys, platform).map((step) => {
    const caps: string[] = []
    if (step.ctrl) caps.push(labels.ctrl)
    if (step.alt) caps.push(labels.alt)
    if (step.shift) caps.push(labels.shift)
    if (step.meta) caps.push(labels.meta)
    caps.push(KEY_LABELS[step.key] ?? (/^(?:[a-z]|f\d{1,2})$/.test(step.key) ? step.key.toUpperCase() : step.key))
    return caps
  })
}

const isSymbol = (key: string) => key.length === 1 && !/[a-z0-9]/.test(key)

function codeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return CODE_KEYS[code] ?? null
}

function matchesStep(step: Step, event: KeyboardEvent): boolean {
  if (event.ctrlKey !== step.ctrl || event.altKey !== step.alt || event.metaKey !== step.meta) return false
  const pressed = event.key.toLowerCase()
  const key = KEY_ALIASES[pressed] ?? pressed
  // "?" already says shift on the layouts that need it and nothing on the ones that do not.
  if (key === step.key) return isSymbol(key) && !step.shift ? true : event.shiftKey === step.shift
  // A modifier changed the character: shift+1 arrives as "!", option+k as "˚". Read the physical key,
  // unless the modifier is AltGr, which is how half of Europe types "@".
  if ((event.shiftKey || event.altKey) && isSymbol(key) && !event.getModifierState?.("AltGraph")) return event.shiftKey === step.shift && codeKey(event.code) === step.key
  return false
}

/** True for a single-step `keys` this event satisfies. For a component that must answer a binding itself, behind a wall the dispatcher will not cross. */
export function matchesKeys(event: KeyboardEvent, keys: string, platform: Platform = detectPlatform()): boolean {
  const steps = parseKeys(keys, platform)
  return steps.length === 1 && matchesStep(steps[0]!, event)
}

/** The step a keydown spells, in the form `remap` takes, or null for a bare modifier. For a "press the new shortcut" field. */
export function keysFromEvent(event: KeyboardEvent): string | null {
  if (IGNORED_KEYS.has(event.key)) return null
  const pressed = event.key.toLowerCase()
  let key = KEY_ALIASES[pressed] ?? pressed
  let shift = event.shiftKey
  if (isSymbol(key)) {
    // option+k arrives as "˚": store the physical key. A shifted symbol such as "?" already carries its shift.
    const physical = event.altKey && !event.getModifierState?.("AltGraph") ? codeKey(event.code) : null
    if (physical) key = physical
    else shift = false
  }
  return stepToString({ ctrl: event.ctrlKey, alt: event.altKey, shift, meta: event.metaKey, key })
}

// Duck-typed so a target from a popout window's realm still counts.
function asElement(target: EventTarget | null): Element | null {
  const el = target as Element | null
  return el && typeof el.closest === "function" ? el : null
}

/** Text inputs, textareas, selects, and anything contenteditable. A checkbox is not typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = asElement(target)
  if (!el) return false
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has((el.getAttribute("type") ?? "text").toLowerCase())
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true
  return el.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null
}

/** Inside a menu, menubar, or listbox, which own arrows, letters, Enter, and Escape while focused. */
export function isMenuTarget(target: EventTarget | null): boolean {
  return asElement(target)?.closest('[role="menu"], [role="menubar"], [role="listbox"]') != null
}

/** The scopes active for an event target, innermost first. Inside a dialog only the scopes declared within it count. */
export function scopeChain(target: EventTarget | null): string[] {
  const chain: string[] = []
  let el = asElement(target)
  const wall = el?.closest(WALLS) ?? null
  while (el) {
    const hit = el.closest(`[${SCOPE_ATTR}]`)
    if (!hit || (wall && !wall.contains(hit))) break
    const name = hit.getAttribute(SCOPE_ATTR)
    if (name && !chain.includes(name)) chain.push(name)
    el = hit.parentElement
  }
  if (!wall) for (const name of ["editing", "global"]) if (!chain.includes(name)) chain.push(name)
  return chain
}

interface Rec {
  binding: HotkeyBinding
  steps: Step[]
  sequence: string[]
  handler?: HotkeyHandler
}

interface Bound {
  handler: HotkeyHandler
  within: HandlerScope | null
}

const isAmbient = (scope: string) => scope === "global" || scope === "editing"

function sameBinding(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return a.keys === b.keys && a.scope === b.scope && a.description === b.description && a.group === b.group && a.when === b.when && a.repeat === b.repeat && a.preventDefault === b.preventDefault
}

function conflictBetween(a: Rec, b: Rec): HotkeyConflict | null {
  if (!a.sequence.length || !b.sequence.length) return null
  const [short, long] = a.sequence.length <= b.sequence.length ? [a, b] : [b, a]
  if (!short.sequence.every((step, i) => long.sequence[i] === step)) return null
  const sa = a.binding.scope
  const sb = b.binding.scope
  const together = sa === sb || (isAmbient(sa) && isAmbient(sb))
  if (!together && !isAmbient(sa) && !isAmbient(sb)) return null
  const kind = !together ? "shadow" : short.sequence.length === long.sequence.length ? "duplicate" : "prefix"
  return { kind, keys: short.sequence.join(" "), ids: [a.binding.id, b.binding.id] }
}

export function createHotkeyRegistry(options: HotkeyRegistryOptions = {}): HotkeyRegistry {
  const platform = options.platform ?? detectPlatform()
  const chordTimeoutMs = options.chordTimeoutMs ?? 1000
  const recs = new Map<string, Rec>()
  const overrides = new Map<string, string>()
  const bound = new Map<string, Bound[]>()
  const listeners = new Set<() => void>()
  const changeListeners = new Set<(overrides: HotkeyOverrides) => void>()
  const attached = new Map<HotkeyTarget, { count: number; listener: (event: Event) => void }>()
  let snapshot: readonly HotkeyEntry[] | null = null
  // Chord state: how many steps of which bindings have matched so far.
  let progress = new Map<string, number>()
  let pendingSteps: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  function emit() {
    snapshot = null
    for (const cb of listeners) cb()
  }

  function notifyChange() {
    const current = Object.fromEntries(overrides)
    for (const cb of changeListeners) cb(current)
  }

  function clearPending(): boolean {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pendingSteps.length) return false
    progress = new Map()
    pendingSteps = []
    return true
  }

  function build(binding: HotkeyBinding, handler?: HotkeyHandler): Rec {
    const defaults = parseKeys(binding.keys, platform)
    let steps = defaults
    const override = overrides.get(binding.id)
    if (override !== undefined) {
      // A stale override from storage must not take the app down: fall back to the default.
      try {
        steps = parseKeys(override, platform)
      } catch {
        steps = defaults
      }
    }
    return { binding, steps, sequence: steps.map(stepToString), handler }
  }

  function rebuild(id?: string) {
    for (const [key, rec] of recs) if (id === undefined || key === id) recs.set(key, build(rec.binding, rec.handler))
    clearPending()
    emit()
  }

  // The elements a binding's handlers are fenced to, in the binding's own scope; null when any handler runs
  // unfenced, empty when nothing is bound. Mirrors what handlerFor lets through.
  function fencesOf(rec: Rec): (Element | null)[] | null {
    if (rec.handler) return null
    const out: (Element | null)[] = []
    for (const { within } of bound.get(rec.binding.id) ?? []) {
      if (!within || within.scope !== rec.binding.scope) return null
      out.push(within.element())
    }
    return out
  }

  // Two bindings whose every handler is fenced to boxes that do not hold one another cannot meet on one key,
  // which is how an order ticket and an RFQ ticket on one desk share mod+enter. Declarations with no handler,
  // or a handler that runs anywhere, are compared as declared.
  function apart(a: Rec, b: Rec): boolean {
    const fa = fencesOf(a)
    const fb = fencesOf(b)
    if (!fa?.length || !fb?.length) return false
    for (const ea of fa) for (const eb of fb) if (ea && eb && (ea === eb || ea.contains(eb) || eb.contains(ea))) return false
    return true
  }

  function conflictsFor(id: string): HotkeyConflict[] {
    const rec = recs.get(id)
    if (!rec) return []
    const out: HotkeyConflict[] = []
    for (const other of recs.values()) {
      const c = other === rec ? null : conflictBetween(rec, other)
      if (c && !apart(rec, other)) out.push(c)
    }
    return out
  }

  function handlerFor(rec: Rec, el: Element | null): HotkeyHandler | null {
    const list = bound.get(rec.binding.id) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const { handler, within } = list[i]!
      if (!within || within.scope !== rec.binding.scope) return handler
      const scopeEl = within.element()
      if (el && scopeEl?.contains(el)) return handler
    }
    return rec.handler ?? null
  }

  function attempt(event: KeyboardEvent, chain: string[], editable: boolean, el: Element | null): boolean {
    let complete: { rank: number; rec: Rec; handler: HotkeyHandler } | null = null
    let advanceRank = Infinity
    let advanceStep = ""
    const advanced = new Map<string, number>()
    for (const rec of recs.values()) {
      const at = pendingSteps.length ? progress.get(rec.binding.id) : 0
      const step = at === undefined ? undefined : rec.steps[at]
      if (at === undefined || !step || !matchesStep(step, event)) continue
      const rank = chain.indexOf(rec.binding.scope)
      if (rank < 0 || (editable && rec.binding.scope !== "editing")) continue
      if (event.repeat && !rec.binding.repeat) continue
      if (rec.binding.when && !rec.binding.when()) continue
      const handler = handlerFor(rec, el)
      if (!handler) continue
      if (at === rec.steps.length - 1) {
        if (!complete || rank < complete.rank) complete = { rank, rec, handler }
      } else {
        advanced.set(rec.binding.id, at + 1)
        if (rank < advanceRank) {
          advanceRank = rank
          advanceStep = stepToString(step)
        }
      }
    }
    // The innermost scope decides. A chord that started closer to the target outranks a finished binding further out.
    if (complete && complete.rank <= advanceRank) {
      if (clearPending()) emit()
      if (complete.rec.binding.preventDefault !== false) event.preventDefault()
      complete.handler(event)
      return true
    }
    if (advanced.size) {
      if (timer) clearTimeout(timer)
      progress = advanced
      pendingSteps = [...pendingSteps, advanceStep]
      timer = setTimeout(() => {
        timer = null
        if (clearPending()) emit()
      }, chordTimeoutMs)
      event.preventDefault()
      emit()
      return true
    }
    return false
  }

  function handle(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || IGNORED_KEYS.has(event.key)) return false
    const target = event.target
    if (isMenuTarget(target)) {
      if (clearPending()) emit()
      return false
    }
    if (pendingSteps.length && event.key === "Escape") {
      clearPending()
      event.preventDefault()
      emit()
      return true
    }
    const chain = scopeChain(target)
    const editable = isEditableTarget(target)
    const el = asElement(target)
    if (attempt(event, chain, editable, el)) return true
    // Not a continuation of the chord in flight: drop the chord and read the key on its own.
    if (clearPending()) {
      emit()
      return attempt(event, chain, editable, el)
    }
    return false
  }

  return {
    platform,
    register(binding, handler) {
      if (!binding.id) throw new Error("hotkeys: a binding needs an id")
      const previous = recs.get(binding.id)
      // Declaring the same thing again (a remount, a hot reload) is not a change.
      if (previous && !handler && sameBinding(previous.binding, binding)) return conflictsFor(binding.id)
      recs.set(binding.id, build(binding, handler ?? previous?.handler))
      clearPending()
      emit()
      return conflictsFor(binding.id)
    },
    unregister(id) {
      if (!recs.delete(id)) return
      clearPending()
      emit()
    },
    bind(id, handler, within = null) {
      const entry: Bound = { handler, within }
      const list = bound.get(id)
      if (list) list.push(entry)
      else bound.set(id, [entry])
      // A fenced handler can settle a conflict, so a settings screen wants to hear about it.
      emit()
      return () => {
        const current = bound.get(id)
        if (!current) return
        const i = current.indexOf(entry)
        if (i < 0) return
        current.splice(i, 1)
        if (!current.length) bound.delete(id)
        emit()
      }
    },
    remap(id, keys) {
      const rec = recs.get(id)
      if (!rec) throw new Error(`hotkeys: cannot remap "${id}", no such binding`)
      const next = normalizeKeys(keys, platform)
      if (next === normalizeKeys(rec.binding.keys, platform)) overrides.delete(id)
      else overrides.set(id, next)
      rebuild(id)
      notifyChange()
      return conflictsFor(id)
    },
    reset(id) {
      if (id === undefined) overrides.clear()
      else overrides.delete(id)
      rebuild(id)
      notifyChange()
    },
    load(next) {
      overrides.clear()
      for (const [id, keys] of Object.entries(next)) overrides.set(id, keys)
      rebuild()
    },
    overrides: () => Object.fromEntries(overrides),
    onChange(cb) {
      changeListeners.add(cb)
      return () => changeListeners.delete(cb)
    },
    list() {
      return (snapshot ??= [...recs.values()].map((rec) => {
        const keys = rec.sequence.join(" ")
        const defaultKeys = normalizeKeys(rec.binding.keys, platform)
        return { ...rec.binding, keys, defaultKeys, remapped: keys !== defaultKeys }
      }))
    },
    conflicts() {
      const all = [...recs.values()]
      const out: HotkeyConflict[] = []
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const c = conflictBetween(all[i]!, all[j]!)
          if (c && !apart(all[i]!, all[j]!)) out.push(c)
        }
      }
      return out
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    attach(target) {
      const t = target ?? (typeof document === "undefined" ? null : document)
      if (!t) return () => {}
      let entry = attached.get(t)
      if (!entry) {
        entry = { count: 0, listener: (event) => void handle(event as KeyboardEvent) }
        t.addEventListener("keydown", entry.listener)
        attached.set(t, entry)
      }
      entry.count++
      let done = false
      return () => {
        if (done) return
        done = true
        entry.count--
        if (entry.count > 0) return
        t.removeEventListener("keydown", entry.listener)
        attached.delete(t)
      }
    },
    pending: () => (pendingSteps.length ? pendingSteps.join(" ") : null),
    handle,
  }
}
