import { withKey } from "./locks.js"
import type { LogLevel } from "./log.js"
import { logLine } from "./log.js"
import { readJson, writeJsonAtomic } from "./state.js"

export const PENDING_CAP = 500
export const PENDING_FILE = "pending.json"
export const FILED_KEEP_MS = 24 * 60 * 60 * 1000
const PENDING_LOCK = "pending"

export const RUBRICS = ["surface", "action", "expected", "actual", "repro", "scope"] as const
export type Rubric = (typeof RUBRICS)[number]

export interface PendingReply {
  requestId: string
  outcome: "asked" | "filed" | "needs_info"
  text: string
}

export interface PendingReport {
  key: string
  requestIds: string[]
  lastReply?: PendingReply
  facts: string[]
  missing: Rubric[]
  rounds: number
  createdAt: number
  updatedAt: number
  state: "asking" | "filed"
  identifier?: string
}

export function isRubric(value: unknown): value is Rubric {
  return typeof value === "string" && (RUBRICS as readonly string[]).includes(value)
}

export function missingOf(present: readonly Rubric[]): Rubric[] {
  const have = new Set(present)
  return RUBRICS.filter((item) => !have.has(item))
}

export async function readPending(dir: string, now: Date, ttlMs: number, logLevel: LogLevel): Promise<PendingReport[]> {
  return withKey(PENDING_LOCK, async () => loadPending(dir, now, ttlMs, logLevel).map(copyReport))
}

export async function upsertPending(dir: string, now: Date, ttlMs: number, logLevel: LogLevel, entry: PendingReport): Promise<void> {
  await withKey(PENDING_LOCK, async () => {
    const entries = loadPending(dir, now, ttlMs, logLevel).filter((item) => item.key !== entry.key)
    entries.push(entry)
    writePending(dir, entries.length > PENDING_CAP ? entries.slice(entries.length - PENDING_CAP) : entries)
  })
}

function loadPending(dir: string, now: Date, ttlMs: number, logLevel: LogLevel): PendingReport[] {
  const raw = readJson<{ entries?: unknown }>(dir, PENDING_FILE)
  const parsed = Array.isArray(raw?.entries) ? raw.entries : []
  const kept: PendingReport[] = []
  let changed = false
  for (const item of parsed) {
    const entry = asReport(item)
    if (!entry) {
      changed = true
      continue
    }
    const age = now.getTime() - entry.updatedAt
    if (entry.state === "asking" && age > ttlMs) {
      logLine("info", "clarify_expired", { count: entry.rounds, category: `missing:${entry.missing.length}` }, logLevel)
      changed = true
      continue
    }
    if (entry.state === "filed" && age > FILED_KEEP_MS) {
      changed = true
      continue
    }
    kept.push(entry)
  }
  if (parsed.length !== kept.length) changed = true
  if (changed) writePending(dir, kept)
  return kept
}

function writePending(dir: string, entries: PendingReport[]): void {
  writeJsonAtomic(dir, PENDING_FILE, { entries })
}

function asReport(value: unknown): PendingReport | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.key !== "string" || !/^[0-9a-f]{64}$/.test(raw.key)) return null
  if (raw.state !== "asking" && raw.state !== "filed") return null
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null
  if (typeof raw.rounds !== "number" || !Number.isFinite(raw.rounds)) return null
  if (!Array.isArray(raw.facts) || !raw.facts.every((fact) => typeof fact === "string")) return null
  if (!Array.isArray(raw.requestIds) || !raw.requestIds.every((id) => typeof id === "string")) return null
  const missing = Array.isArray(raw.missing) ? raw.missing.filter(isRubric) : []
  const report: PendingReport = {
    key: raw.key,
    requestIds: raw.requestIds.filter((id) => id.length > 0).slice(0, 6),
    facts: raw.facts.slice(0, 4),
    missing,
    rounds: Math.max(0, Math.min(4, Math.floor(raw.rounds))),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    state: raw.state,
  }
  if (typeof raw.identifier === "string" && raw.identifier) report.identifier = raw.identifier
  const reply = raw.lastReply
  if (reply && typeof reply === "object") {
    const item = reply as Record<string, unknown>
    if (
      (item.outcome === "asked" || item.outcome === "filed" || item.outcome === "needs_info") &&
      typeof item.text === "string" &&
      typeof item.requestId === "string"
    ) {
      report.lastReply = { requestId: item.requestId, outcome: item.outcome, text: item.text.slice(0, 600) }
    }
  }
  return report
}

function copyReport(entry: PendingReport): PendingReport {
  return {
    ...entry,
    requestIds: [...entry.requestIds],
    facts: [...entry.facts],
    missing: [...entry.missing],
    lastReply: entry.lastReply ? { ...entry.lastReply } : undefined,
  }
}
