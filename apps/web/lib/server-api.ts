export async function serverApi<T>(path: string): Promise<T | null> {
  const base = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000"
  try {
    const res = await fetch(`${base}${path}`, { cache: "no-store" })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}
