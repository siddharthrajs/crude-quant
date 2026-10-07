// REST client for the FastAPI backend: instrument metadata and synthetic structures.
// The base URL defaults to the local dev server; override with VITE_API_URL for anything else.

export const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
export const WS_URL = API_URL.replace(/^http/, "ws")

export interface InstrumentRecord {
  item: string
  instrument_id: string
  product: string
  product_label: string
  tenor: string
  label: string
  instrument_type: "OUTRIGHT" | "1MS" | "FLY" | string
  sort_key: number[]
}

export interface StructureLeg {
  item: string
  weight: number
}

export interface StructureRecord {
  id: string
  label: string
  legs: StructureLeg[]
  product: string | null
  kind: "dfly" | "custom" | string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`)
  return res.json() as Promise<T>
}

export async function getInstruments(signal?: AbortSignal): Promise<InstrumentRecord[]> {
  return json<InstrumentRecord[]>(await fetch(`${API_URL}/api/instruments`, { signal }))
}

export async function getStructures(signal?: AbortSignal): Promise<StructureRecord[]> {
  return json<StructureRecord[]>(await fetch(`${API_URL}/api/structures`, { signal }))
}

export async function createStructure(label: string, legs: StructureLeg[]): Promise<StructureRecord> {
  return json<StructureRecord>(
    await fetch(`${API_URL}/api/structures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, legs }),
    }),
  )
}

export function deleteStructure(id: string): Promise<void> {
  return fetch(`${API_URL}/api/structures/${encodeURIComponent(id)}`, { method: "DELETE" }).then((res) => {
    if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`)
  })
}
