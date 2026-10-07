import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

// A panel in a window of its own, without losing the panel.
//
// The content is rendered through a portal into one host element that never changes. The host sits
// in a slot in the page while the popout is closed and in the popout's body while it is open, and
// moving a DOM node does not remount what React rendered into it. State, subscriptions, and context
// all carry over, in both directions.
//
// The popout runs in the opener's JavaScript, so it is one React tree and one set of stores. What
// does not come along by itself is the page's CSS, which is copied in and kept in step with the
// opener's root element, where a theme class lives.

export interface PopoutOptions {
  title?: string
  /** Inner size in CSS pixels. Default 640 by 420. */
  width?: number
  height?: number
  left?: number
  top?: number
  /** The window name. Opening a name that is already open reuses that window. A new window each time by default. */
  name?: string
  /** Copy the page's stylesheets, and mirror the root element's attributes, into the popout. Default true. */
  copyStyles?: boolean
  /** Instead of `window.open`, for a shell that makes its own windows. It must hand back a same-origin window synchronously. */
  openWindow?: (features: string) => Window | null
  onOpen?: (popout: Window) => void
  /** Closed from either side: `close()`, the window's own close button, or the opener going away. */
  onClose?: () => void
  /** The browser refused the window. `open()` has to run inside a click or a key press. */
  onBlocked?: () => void
}

export interface Popout {
  isOpen: boolean
  window: Window | null
  /** Render into this with `createPortal`. Null on a server. */
  host: HTMLElement | null
  /** Put this on an empty element where the content sits while the popout is closed. */
  slotRef: (node: HTMLElement | null) => void
  /** False when the browser blocked it. */
  open: () => boolean
  close: () => void
}

function features(options: PopoutOptions): string {
  const parts = ["popup=yes", `width=${Math.round(options.width ?? 640)}`, `height=${Math.round(options.height ?? 420)}`]
  if (options.left !== undefined) parts.push(`left=${Math.round(options.left)}`)
  if (options.top !== undefined) parts.push(`top=${Math.round(options.top)}`)
  return parts.join(",")
}

/** Makes `to`'s root element carry the attributes of `from`'s, which is where a theme class lives. */
export function mirrorRoot(from: Document, to: Document) {
  for (const name of to.documentElement.getAttributeNames()) if (!from.documentElement.hasAttribute(name)) to.documentElement.removeAttribute(name)
  for (const name of from.documentElement.getAttributeNames()) to.documentElement.setAttribute(name, from.documentElement.getAttribute(name) ?? "")
}

function copyStyles(from: Document, to: Document) {
  for (const node of from.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')) {
    const copy = to.importNode(node, true)
    // The property is the absolute URL; the attribute may be relative, and the popout is about:blank.
    if (copy.tagName === "LINK") (copy as HTMLLinkElement).href = (node as HTMLLinkElement).href
    to.head.appendChild(copy)
  }
  to.body.className = from.body.className
  mirrorRoot(from, to)
}

// In the page the host takes no box of its own; in the popout it is the page.
function place(host: HTMLElement, slot: HTMLElement | null, popout: Window | null) {
  host.dataset.popout = popout ? "open" : "closed"
  host.style.cssText = popout ? "display:block;height:100vh" : "display:contents"
  if (popout) popout.document.body.appendChild(host)
  else if (slot) slot.appendChild(host)
  else host.remove()
}

export function usePopout(options: PopoutOptions = {}): Popout {
  const [host] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.createElement("div")))
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [popout, setPopout] = useState<Window | null>(null)
  const live = useRef<Window | null>(null)
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  useLayoutEffect(() => {
    if (host) place(host, slot, popout)
  }, [host, slot, popout])

  const finish = useCallback((target: Window) => {
    if (live.current !== target) return
    live.current = null
    setPopout(null)
    latest.current.onClose?.()
  }, [])

  useEffect(() => {
    if (!popout) return
    // pagehide is also a reload, which leaves an empty about:blank behind: close that too.
    const closed = () => {
      finish(popout)
      popout.close()
    }
    const shut = () => popout.close()
    popout.addEventListener("pagehide", closed)
    window.addEventListener("pagehide", shut)
    let observer: MutationObserver | null = null
    if (latest.current.copyStyles !== false && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => mirrorRoot(document, popout.document))
      observer.observe(document.documentElement, { attributes: true })
    }
    return () => {
      popout.removeEventListener("pagehide", closed)
      window.removeEventListener("pagehide", shut)
      observer?.disconnect()
    }
  }, [popout, finish])

  // Unmounting the panel takes its window with it.
  useEffect(
    () => () => {
      live.current?.close()
      live.current = null
    },
    [],
  )

  const open = useCallback(() => {
    if (live.current && !live.current.closed) {
      live.current.focus()
      return true
    }
    const o = latest.current
    const next = o.openWindow ? o.openWindow(features(o)) : window.open("", o.name ?? "_blank", features(o))
    if (!next) {
      o.onBlocked?.()
      return false
    }
    if (o.title !== undefined) next.document.title = o.title
    if (o.copyStyles !== false) copyStyles(document, next.document)
    live.current = next
    setPopout(next)
    o.onOpen?.(next)
    return true
  }, [])

  const close = useCallback(() => {
    const target = live.current
    if (!target) return
    finish(target)
    target.close()
  }, [finish])

  return { isOpen: popout !== null, window: popout, host, slotRef: setSlot, open, close }
}
