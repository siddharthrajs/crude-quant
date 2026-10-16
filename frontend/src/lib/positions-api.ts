// REST client for the positions/books/trade-journal endpoints. Requires auth, unlike `api.ts`'s open
// instrument/structure routes -- follows `auth-api.ts`'s manual-Authorization-header fetch shape.

import { API_URL } from "@/lib/api"
import type { Side } from "@/lib/position-pricing"
import type { Leg } from "@/lib/strategy-resolver"

export type { Side } from "@/lib/position-pricing"

export type BookScope = "personal" | "team"
/** "live" is the real book; "paper" is its simulated twin (separate tables, same shapes/rules). */
export type BookMode = "live" | "paper"
export type PositionStatus = "open" | "closed"

export interface Position {
  id: number
  book_id: number
  owner_id: number
  owner_username: string
  linked_position_id: number | null
  product: string
  strategy_code: string
  strategy_label: string
  tenor: string | null
  legs: Leg[]
  size: number
  side: Side
  average_price: number
  stop_loss: number | null
  take_profit: number | null
  status: PositionStatus
  opened_at: string
  closed_at: string | null
  exit_price: number | null
  realized_pnl: number | null
}

export interface JournalEntry {
  id: number
  book_id: number
  position_id: number
  owner_id: number
  owner_username: string
  product: string
  strategy_label: string
  tenor: string | null
  side: Side
  size: number
  average_price: number
  exit_price: number
  realized_pnl: number
  stop_loss: number | null
  take_profit: number | null
  opened_at: string
  closed_at: string
}

/** One entry (partial fill) netted into an open position's size and average price. */
export interface PositionFill {
  id: number
  size: number
  price: number
  created_at: string
}

/** A fill as submitted by the editor: no `id` = a new fill; existing fills left out are deleted. */
export interface FillEditInput {
  id: number | null
  size: number
  price: number
}

export interface PositionEditInput {
  fills: FillEditInput[]
  stop_loss: number | null
  take_profit: number | null
}

export interface PositionCreateInput {
  product: string
  strategy_code: string
  strategy_label: string
  tenor: string | null
  legs: Leg[]
  size: number
  side: Side
  average_price: number
  stop_loss: number | null
  take_profit: number | null
  share_with_team: boolean
}

async function positionsError(res: Response): Promise<never> {
  const body = await res.json().catch(() => null)
  throw new Error((body && typeof body.detail === "string" && body.detail) || `${res.status} ${res.statusText}`)
}

function basePath(mode: BookMode): string {
  return `${API_URL}/api/${mode === "paper" ? "paper-positions" : "positions"}`
}

function authHeaders(token: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
}

export async function getPositions(token: string, scope: BookScope, status?: PositionStatus, mode: BookMode = "live"): Promise<Position[]> {
  const params = new URLSearchParams({ scope })
  if (status) params.set("status_filter", status)
  const res = await fetch(`${basePath(mode)}?${params}`, { headers: authHeaders(token) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<Position[]>
}

export async function createPosition(token: string, body: PositionCreateInput, mode: BookMode = "live"): Promise<Position> {
  const res = await fetch(basePath(mode), { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<Position>
}

export async function getPositionFills(token: string, id: number, mode: BookMode = "live"): Promise<PositionFill[]> {
  const res = await fetch(`${basePath(mode)}/${id}/fills`, { headers: authHeaders(token) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<PositionFill[]>
}

export async function editPosition(token: string, id: number, body: PositionEditInput, mode: BookMode = "live"): Promise<Position> {
  const res = await fetch(`${basePath(mode)}/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(body) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<Position>
}

export async function closePosition(token: string, id: number, exitPrice: number, size?: number, mode: BookMode = "live"): Promise<Position> {
  const res = await fetch(`${basePath(mode)}/${id}/close`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ exit_price: exitPrice, size: size ?? null }),
  })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<Position>
}

export async function getJournal(token: string, scope: BookScope, mode: BookMode = "live"): Promise<JournalEntry[]> {
  const res = await fetch(`${basePath(mode)}/journal?scope=${scope}`, { headers: authHeaders(token) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<JournalEntry[]>
}

export interface TeamMember {
  id: number
  username: string
  team_id: number
}

/** Manager-only: the members whose journals the manager can view. */
export async function getTeamMembers(token: string): Promise<TeamMember[]> {
  const res = await fetch(`${API_URL}/api/manager/members`, { headers: authHeaders(token) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<TeamMember[]>
}

/** Manager-only: one member's closed trades (their personal book), or every member's combined when `userId` is null. */
export async function getMemberJournal(token: string, userId: number | null, mode: BookMode = "live"): Promise<JournalEntry[]> {
  const params = new URLSearchParams({ mode })
  if (userId !== null) params.set("user_id", String(userId))
  const res = await fetch(`${API_URL}/api/manager/journal?${params}`, { headers: authHeaders(token) })
  if (!res.ok) return positionsError(res)
  return res.json() as Promise<JournalEntry[]>
}

export async function deleteJournalEntries(token: string, ids: number[], mode: BookMode = "live"): Promise<void> {
  const res = await fetch(`${basePath(mode)}/journal`, { method: "DELETE", headers: authHeaders(token), body: JSON.stringify({ ids }) })
  if (!res.ok) return positionsError(res)
}
