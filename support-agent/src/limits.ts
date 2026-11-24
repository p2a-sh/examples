export interface Buckets {
  bursts: Map<string, number[]>
  daily: Map<string, { day: string; count: number }>
}

export function emptyBuckets(): Buckets {
  return { bursts: new Map(), daily: new Map() }
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export interface LimitDecision {
  ok: boolean
  scope?: "burst" | "sender_day" | "owner_day" | "context_day"
  limit?: number
  unit?: string
  retryMinutes?: number
}

export function takeLimit(
  buckets: Buckets,
  input: {
    did: string
    owner: string
    contextId: string
    now: Date
    burst: number
    burstWindowSeconds: number
    senderPerDay: number
    ownerPerDay: number
    contextPerDay: number
  },
): LimitDecision {
  const nowMs = input.now.getTime()
  const windowMs = input.burstWindowSeconds * 1000
  const burstKey = `did:${input.did}`
  const recent = (buckets.bursts.get(burstKey) ?? []).filter((stamp) => nowMs - stamp < windowMs)
  if (recent.length >= input.burst) {
    const oldest = recent[0] ?? nowMs
    const retryMinutes = Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 60000))
    buckets.bursts.set(burstKey, recent)
    return { ok: false, scope: "burst", limit: input.burst, unit: `${Math.round(input.burstWindowSeconds / 60)} minutes`, retryMinutes }
  }
  const day = utcDay(input.now)
  const dailyChecks: { key: string; limit: number; scope: LimitDecision["scope"]; unit: string }[] = [
    { key: `sender:${input.did}`, limit: input.senderPerDay, scope: "sender_day", unit: "day" },
    { key: `owner:${input.owner}`, limit: input.ownerPerDay, scope: "owner_day", unit: "day" },
    { key: `context:${input.contextId}`, limit: input.contextPerDay, scope: "context_day", unit: "day" },
  ]
  for (const check of dailyChecks) {
    const current = buckets.daily.get(check.key)
    const count = current && current.day === day ? current.count : 0
    if (count >= check.limit) {
      return { ok: false, scope: check.scope, limit: check.limit, unit: check.unit, retryMinutes: minutesUntilUtcDay(input.now) }
    }
  }
  recent.push(nowMs)
  buckets.bursts.set(burstKey, recent)
  for (const check of dailyChecks) {
    const current = buckets.daily.get(check.key)
    const count = current && current.day === day ? current.count : 0
    buckets.daily.set(check.key, { day, count: count + 1 })
  }
  return { ok: true }
}

function minutesUntilUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 60000))
}
