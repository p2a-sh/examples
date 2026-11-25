import { readText, writeJsonAtomic } from "./state.js"
import { dayMovedForward, utcDay } from "./limits.js"
import { logLine, type LogLevel } from "./log.js"

export interface AlertState {
  day: string
  sent: number
  summarized: boolean
  suppressed: number
}

export interface AlertInfo {
  kind: "budget_50" | "budget_80" | "connection_cap" | "bundle_rejected" | "escalate" | "summary"
  category?: string
  address?: string
}

export function emptyAlerts(now: Date): AlertState {
  return { day: utcDay(now), sent: 0, summarized: false, suppressed: 0 }
}

export function loadAlerts(dir: string, now: Date): AlertState {
  const text = readText(dir, "alerts.json")
  const fresh = emptyAlerts(now)
  if (!text) return fresh
  try {
    const saved = JSON.parse(text) as Partial<AlertState>
    if (saved.day !== fresh.day) return fresh
    return {
      day: fresh.day,
      sent: typeof saved.sent === "number" ? saved.sent : 0,
      summarized: saved.summarized === true,
      suppressed: typeof saved.suppressed === "number" ? saved.suppressed : 0,
    }
  } catch {
    return fresh
  }
}

export function saveAlerts(dir: string, state: AlertState): void {
  writeJsonAtomic(dir, "alerts.json", state)
}

export function alertText(info: AlertInfo): string {
  if (info.kind === "budget_50") return "Budget alert: 50% of the daily support budget is used."
  if (info.kind === "budget_80") return "Budget alert: 80% of the daily support budget is used."
  if (info.kind === "connection_cap") return "Connection alert: the daily accept cap was reached. New requests stay pending."
  if (info.kind === "bundle_rejected") return "Bundle alert: the new document bundle was rejected. The previous bundle is still in use."
  if (info.kind === "summary") return "Alert summary: the daily alert cap was reached. Further alerts are counted and not sent."
  return `Escalation (${info.category ?? "general"}) from ${info.address ?? "unknown"}.`
}

export async function dispatchAlert(input: {
  info: AlertInfo
  now: Date
  state: AlertState
  alertTo?: string
  alertsPerDay: number
  logLevel: LogLevel
  send: (to: string, text: string) => Promise<void>
}): Promise<void> {
  if (dayMovedForward(input.state.day, input.now)) {
    input.state.day = utcDay(input.now)
    input.state.sent = 0
    input.state.summarized = false
    input.state.suppressed = 0
  }
  const summary = input.state.sent >= input.alertsPerDay
  if (summary && input.state.summarized) {
    input.state.suppressed += 1
    return
  }
  const info = summary ? { kind: "summary" as const } : input.info
  const text = alertText(info)
  if (!input.alertTo) {
    if (summary) input.state.summarized = true
    else input.state.sent += 1
    logLine("warn", "alert", { category: info.category ?? info.kind, count: input.state.sent }, input.logLevel)
    return
  }
  await input.send(input.alertTo, text)
  if (summary) input.state.summarized = true
  else input.state.sent += 1
}
