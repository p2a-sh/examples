import { readText, writeJsonAtomic } from "./state.js"
import { utcDay } from "./limits.js"
import { logLine, type LogLevel } from "./log.js"

export interface AlertState {
  day: string
  sent: number
  summarized: boolean
}

export interface AlertInfo {
  kind: "budget_50" | "budget_80" | "connection_cap" | "bundle_rejected" | "escalate" | "summary"
  category?: string
  address?: string
}

export function emptyAlerts(now: Date): AlertState {
  return { day: utcDay(now), sent: 0, summarized: false }
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
  const day = utcDay(input.now)
  if (input.state.day !== day) {
    input.state.day = day
    input.state.sent = 0
    input.state.summarized = false
  }
  const summary = input.state.sent >= input.alertsPerDay
  if (summary && input.state.summarized) return
  const info = summary ? { kind: "summary" as const } : input.info
  if (summary) input.state.summarized = true
  else input.state.sent += 1
  const text = alertText(info)
  if (!input.alertTo) {
    logLine("warn", "alert", { category: info.category ?? info.kind, count: input.state.sent }, input.logLevel)
    return
  }
  await input.send(input.alertTo, text)
}
