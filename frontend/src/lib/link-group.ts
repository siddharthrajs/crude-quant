export type LinkGroupId = 1 | 2 | 3 | 4

/** `null` is unlinked. */
export type LinkGroup = LinkGroupId | null

export const LINK_GROUPS: readonly LinkGroupId[] = [1, 2, 3, 4]

export interface LinkGroupState {
  group: LinkGroupId
  symbol: string | null
  /** Who wrote it: whatever the writer passed to `set`, usually a panel's id. */
  source: string | null
  /** Counts writes. Between windows the higher version wins. 0 is never written, or only seeded. */
  version: number
}

export type LinkMessage =
  | { kind: "tradecn-link"; type: "set"; origin: string; group: LinkGroupId; symbol: string | null; source: string | null; version: number }
  | { kind: "tradecn-link"; type: "hello"; origin: string }

export interface LinkTransport {
  post(message: LinkMessage): void
  /** Deliver what other windows post. Returns the unsubscribe. */
  subscribe(cb: (message: LinkMessage) => void): () => void
}

export interface LinkGroupStore {
  /** This store's id on the transport. */
  readonly id: string
  /** The same object until the group changes, so it is safe as a `useSyncExternalStore` snapshot. */
  get(group: LinkGroupId): LinkGroupState
  /** Blank is null. Writing the symbol a group already holds changes nothing. */
  set(group: LinkGroupId, symbol: string | null, source?: string | null): void
  /**
   * Give a group that nobody has written to a first symbol, from a panel that joined it holding one.
   * A seed stays in this window and any real write replaces it, here or from another window, so a
   * symbol restored from storage never overrules the one people are looking at.
   */
  seed(group: LinkGroupId, symbol: string | null, source?: string | null): void
  subscribe(cb: () => void): () => void
  /** Start listening to the transport and ask the other windows what they hold. Returns the disconnect. */
  connect(): () => void
}

export interface LinkGroupStoreOptions {
  /** Omit or pass null to keep links inside this window. */
  transport?: LinkTransport | null
  id?: string
}

/** Unlinked, then 1 to 4, then unlinked again. `step` -1 goes the other way. */
export function cycleLinkGroup(group: LinkGroup, step: 1 | -1 = 1): LinkGroup {
  const order: LinkGroup[] = [null, ...LINK_GROUPS]
  const at = Math.max(0, order.indexOf(group))
  return order[(at + step + order.length) % order.length]!
}

export function normalizeSymbol(symbol: string | null | undefined): string | null {
  const next = typeof symbol === "string" ? symbol.trim() : ""
  return next ? next : null
}

function isGroupId(value: unknown): value is LinkGroupId {
  return LINK_GROUPS.includes(value as LinkGroupId)
}

/** Messages arrive from outside the page; take nothing on trust. */
export function isLinkMessage(value: unknown): value is LinkMessage {
  if (!value || typeof value !== "object") return false
  const m = value as Record<string, unknown>
  if (m.kind !== "tradecn-link" || typeof m.origin !== "string" || !m.origin) return false
  if (m.type === "hello") return true
  if (m.type !== "set") return false
  return isGroupId(m.group) && (m.symbol === null || typeof m.symbol === "string") && (m.source === null || typeof m.source === "string") && typeof m.version === "number" && Number.isFinite(m.version)
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createLinkGroupStore(options: LinkGroupStoreOptions = {}): LinkGroupStore {
  const id = options.id ?? makeId()
  const transport = options.transport ?? null
  const states = new Map<LinkGroupId, LinkGroupState>(LINK_GROUPS.map((group) => [group, { group, symbol: null, source: null, version: 0 }]))
  // Which store wrote each group's current state: the tie-break when two versions are equal.
  const origins = new Map<LinkGroupId, string>()
  const listeners = new Set<() => void>()
  let connections = 0
  let disconnect: (() => void) | null = null

  function emit() {
    for (const cb of listeners) cb()
  }

  function announce(state: LinkGroupState) {
    if (connections > 0) transport?.post({ kind: "tradecn-link", type: "set", origin: origins.get(state.group) ?? id, group: state.group, symbol: state.symbol, source: state.source, version: state.version })
  }

  function receive(message: LinkMessage) {
    if (!isLinkMessage(message) || message.origin === id) return
    if (message.type === "hello") {
      for (const state of states.values()) if (state.version > 0) announce(state)
      return
    }
    const current = states.get(message.group)!
    if (message.version < current.version) return
    if (message.version === current.version && (message.symbol === current.symbol || message.origin <= (origins.get(message.group) ?? ""))) return
    origins.set(message.group, message.origin)
    states.set(message.group, { group: message.group, symbol: normalizeSymbol(message.symbol), source: message.source, version: message.version })
    emit()
  }

  return {
    id,
    get: (group) => states.get(group)!,
    set(group, symbol, source = null) {
      const current = states.get(group)
      if (!current) return
      const next = normalizeSymbol(symbol)
      // Writing a seed's own symbol still counts: it is the first real write, and other windows have not heard it.
      if (next === current.symbol && (current.version > 0 || next === null)) return
      const state = { group, symbol: next, source, version: current.version + 1 }
      origins.set(group, id)
      states.set(group, state)
      emit()
      announce(state)
    },
    seed(group, symbol, source = null) {
      const current = states.get(group)
      const next = normalizeSymbol(symbol)
      if (!current || current.version > 0 || current.symbol !== null || next === null) return
      states.set(group, { group, symbol: next, source, version: 0 })
      emit()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    connect() {
      if (!transport) return () => {}
      if (connections++ === 0) {
        disconnect = transport.subscribe(receive)
        transport.post({ kind: "tradecn-link", type: "hello", origin: id })
      }
      let done = false
      return () => {
        if (done) return
        done = true
        if (--connections > 0) return
        disconnect?.()
        disconnect = null
      }
    },
  }
}

export interface CallbackTransportOptions {
  /** Send a message to the other windows: a desktop shell's event, a socket, a worker's port. */
  send: (message: LinkMessage) => void
  /**
   * Deliver what the other windows send to `deliver`, and return the way to stop. Called once, for the
   * first subscriber; its return is called when the last subscriber leaves. What arrives is checked
   * before it reaches a store, so hand over whatever the channel carries.
   */
  receive: (deliver: (message: unknown) => void) => () => void
}

/**
 * A transport over two functions, for a shell whose windows are separate JavaScript contexts and
 * cannot share a `BroadcastChannel`: each window runs its own provider, and the shell's own events
 * carry the links between them.
 */
export function createCallbackTransport({ send, receive }: CallbackTransportOptions): LinkTransport {
  const listeners = new Set<(message: LinkMessage) => void>()
  let stop: (() => void) | null = null
  return {
    post(message) {
      send(message)
    },
    subscribe(cb) {
      listeners.add(cb)
      if (!stop) {
        stop = receive((message) => {
          if (isLinkMessage(message)) for (const l of [...listeners]) l(message)
        })
      }
      return () => {
        listeners.delete(cb)
        if (listeners.size || !stop) return
        stop()
        stop = null
      }
    },
  }
}

/** Every same-origin window and tab that opens this channel name shares links. The channel opens with the first subscriber and closes with the last. */
export function createBroadcastChannelTransport(name = "tradecn-link"): LinkTransport {
  const listeners = new Set<(message: LinkMessage) => void>()
  let channel: BroadcastChannel | null = null
  const onMessage = (event: MessageEvent<unknown>) => {
    if (isLinkMessage(event.data)) for (const cb of listeners) cb(event.data)
  }
  return {
    post(message) {
      channel?.postMessage(message)
    },
    subscribe(cb) {
      listeners.add(cb)
      if (!channel && typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(name)
        channel.addEventListener("message", onMessage)
      }
      return () => {
        listeners.delete(cb)
        if (listeners.size || !channel) return
        channel.removeEventListener("message", onMessage)
        channel.close()
        channel = null
      }
    },
  }
}
