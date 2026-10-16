// REST client for the auth endpoints (login, current user, admin user creation).

import { API_URL } from "@/lib/api"

export interface AuthUser {
  id: number
  username: string
  team_id: number
  is_active: boolean
  is_superuser: boolean
  role: Role
  created_at: string
}

export type Role = "admin" | "manager" | "member"

export interface Team {
  id: number
  name: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
}

async function authError(res: Response): Promise<never> {
  const body = await res.json().catch(() => null)
  throw new Error((body && typeof body.detail === "string" && body.detail) || `${res.status} ${res.statusText}`)
}

export async function login(username: string, password: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ username, password })
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) return authError(res)
  return res.json() as Promise<TokenResponse>
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const res = await fetch(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return authError(res)
  return res.json() as Promise<AuthUser>
}

export interface AccountUpdateResponse {
  user: AuthUser
  access_token: string
  token_type: string
}

export async function updateMe(
  token: string,
  update: { currentPassword: string; newUsername?: string; newPassword?: string },
): Promise<AccountUpdateResponse> {
  const res = await fetch(`${API_URL}/api/auth/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      current_password: update.currentPassword,
      new_username: update.newUsername,
      new_password: update.newPassword,
    }),
  })
  if (!res.ok) return authError(res)
  return res.json() as Promise<AccountUpdateResponse>
}

export async function createUser(
  token: string,
  username: string,
  password: string,
  teamId: number,
  role: Role = "member",
): Promise<AuthUser> {
  const res = await fetch(`${API_URL}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, password, team_id: teamId, role }),
  })
  if (!res.ok) return authError(res)
  return res.json() as Promise<AuthUser>
}

/** Admin-only: every account. */
export async function fetchUsers(token: string): Promise<AuthUser[]> {
  const res = await fetch(`${API_URL}/api/auth/users`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return authError(res)
  return res.json() as Promise<AuthUser[]>
}

/** Admin-only: permanently deletes accounts and their trades. */
export async function deleteUsers(token: string, ids: number[]): Promise<void> {
  const res = await fetch(`${API_URL}/api/auth/users/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) return authError(res)
}

export async function fetchTeams(token: string): Promise<Team[]> {
  const res = await fetch(`${API_URL}/api/teams`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return authError(res)
  return res.json() as Promise<Team[]>
}
