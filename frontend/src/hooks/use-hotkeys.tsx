import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react"
import { createHotkeyRegistry, type HandlerScope, type HotkeyBinding, type HotkeyEntry, type HotkeyHandler, type HotkeyRegistry, type HotkeyScopeName, type HotkeyTarget } from "@/lib/hotkeys"

// React bindings for the hotkey registry. The registry does the work and knows nothing about React;
// this file puts one in context, attaches its listener, marks scopes in the DOM, and keeps a
// component's handler attached for as long as the component is mounted.

const RegistryContext = createContext<HotkeyRegistry | null>(null)
const ScopeContext = createContext<HandlerScope | null>(null)

export interface HotkeysProviderProps {
  /** Bring your own to declare bindings and load overrides before the first render. One is created otherwise. */
  registry?: HotkeyRegistry
  /** Declared on mount, removed on unmount. Keep the array's identity stable: a module constant. */
  bindings?: readonly HotkeyBinding[]
  /** Where to listen. `document` by default; a popout window's document for a second one. */
  target?: HotkeyTarget
  children?: ReactNode
}

export function HotkeysProvider({ registry, bindings, target, children }: HotkeysProviderProps) {
  const [own] = useState(() => createHotkeyRegistry())
  const value = registry ?? own
  useEffect(() => value.attach(target), [value, target])
  useEffect(() => {
    if (!bindings) return
    for (const binding of bindings) value.register(binding)
    return () => {
      for (const binding of bindings) value.unregister(binding.id)
    }
  }, [value, bindings])
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>
}

/** The registry from the nearest provider. */
export function useHotkeys(): HotkeyRegistry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error("useHotkeys needs a <HotkeysProvider> above it")
  return registry
}

/** The same, or null without a provider, for components that treat hotkeys as optional. */
export function useMaybeHotkeys(): HotkeyRegistry | null {
  return useContext(RegistryContext)
}

export interface UseHotkeyOptions {
  /** False detaches the handler; the binding stays declared and listed. */
  enabled?: boolean
}

/**
 * Attach a handler to a declared binding while this component is mounted. Inside a `HotkeyScope` of
 * the binding's own scope, the handler answers only for events from that scope element, so two
 * instances of a panel each get their own keys.
 */
export function useHotkey(id: string, handler: HotkeyHandler, options: UseHotkeyOptions = {}): void {
  const registry = useHotkeys()
  const scope = useContext(ScopeContext)
  const enabled = options.enabled !== false
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    if (!enabled) return
    return registry.bind(id, (event) => latest.current(event), scope)
  }, [registry, id, enabled, scope])
}

/** Every binding with its keys in force, for a help overlay or a settings screen. Re-renders on declare, remap, and reset, and when a handler attaches or detaches. */
export function useHotkeyList(): readonly HotkeyEntry[] {
  const registry = useHotkeys()
  return useSyncExternalStore(registry.subscribe, registry.list, registry.list)
}

/** The chord typed so far (`"g"`), or null. For a "g …" hint in a status bar. */
export function usePendingChord(): string | null {
  const registry = useHotkeys()
  return useSyncExternalStore(registry.subscribe, registry.pending, registry.pending)
}

export interface HotkeyScopeProps extends Omit<ComponentProps<"div">, "ref"> {
  scope: HotkeyScopeName
}

/**
 * Marks a subtree as a scope. Keys pressed with focus inside it reach this scope's bindings first.
 * It takes focus on click (`tabIndex={-1}`) so that clicking a panel is enough to aim the keyboard at it.
 */
export function HotkeyScope({ scope, children, ...props }: HotkeyScopeProps) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const value = useMemo<HandlerScope>(() => ({ scope, element: () => element }), [scope, element])
  return (
    <ScopeContext.Provider value={value}>
      <div tabIndex={-1} {...props} ref={setElement} data-hotkey-scope={scope}>
        {children}
      </div>
    </ScopeContext.Provider>
  )
}
