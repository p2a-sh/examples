import { statSync } from "node:fs"
import { join } from "node:path"
import { writeJsonAtomic } from "./state.js"

export function touchHealth(dir: string, now = new Date()): void {
  writeJsonAtomic(dir, "health.json", { at: now.toISOString() })
}

export function healthFresh(dir: string, maxAgeMs = 90_000, now = Date.now()): boolean {
  try {
    const stat = statSync(join(dir, "health.json"))
    return now - stat.mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

export const HEALTH_INTERVAL_MS = 30_000

// Keep health.json fresh while the agent is listening, even when no messages arrive.
export function startHeartbeat(dir: string, now: () => Date = () => new Date(), intervalMs = HEALTH_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try {
      touchHealth(dir, now())
    } catch {
      // A missed beat only makes the healthcheck stricter; the next one retries.
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
