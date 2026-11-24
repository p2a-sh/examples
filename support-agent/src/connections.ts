import { fileExists, readText, writeJsonAtomic } from "./state.js"
import { utcDay } from "./limits.js"

export interface ConnectionState {
  day: string
  accepts: number
  alertedCap: boolean
  deferred: number
  blocked: number
}

export type ConnectionAction = "accept" | "block" | "pending"

export function emptyConnections(now: Date): ConnectionState {
  return { day: utcDay(now), accepts: 0, alertedCap: false, deferred: 0, blocked: 0 }
}

export function loadConnections(dir: string, now: Date): ConnectionState {
  const saved = readJson(dir)
  const fresh = emptyConnections(now)
  if (!saved) return fresh
  if (saved.day !== fresh.day) return fresh
  return {
    day: saved.day,
    accepts: saved.accepts ?? 0,
    alertedCap: saved.alertedCap === true,
    deferred: saved.deferred ?? 0,
    blocked: saved.blocked ?? 0,
  }
}

export function saveConnections(dir: string, state: ConnectionState): void {
  writeJsonAtomic(dir, "connections.json", state)
}

export function decideConnection(input: {
  owner: string
  now: Date
  stateDir: string
  policy: "accept_capped" | "manual"
  acceptsPerDay: number
  state: ConnectionState
}): { action: ConnectionAction; alert: boolean } {
  roll(input.state, input.now)
  if (fileExists(input.stateDir, "KILL") || fileExists(input.stateDir, "PAUSED")) {
    input.state.deferred += 1
    return { action: "pending", alert: false }
  }
  if (ownerListed(input.stateDir, input.owner)) {
    input.state.blocked += 1
    return { action: "block", alert: false }
  }
  if (input.policy === "manual" || !input.owner.trim()) {
    input.state.deferred += 1
    return { action: "pending", alert: false }
  }
  if (input.state.accepts >= input.acceptsPerDay) {
    input.state.deferred += 1
    const alert = !input.state.alertedCap
    input.state.alertedCap = true
    return { action: "pending", alert }
  }
  input.state.accepts += 1
  return { action: "accept", alert: false }
}

function roll(state: ConnectionState, now: Date): void {
  const day = utcDay(now)
  if (state.day === day) return
  state.day = day
  state.accepts = 0
  state.alertedCap = false
  state.deferred = 0
  state.blocked = 0
}

function ownerListed(dir: string, owner: string): boolean {
  const text = readText(dir, "blocklist.txt")
  if (!text) return false
  const needle = owner.trim().toLowerCase().replace(/^@/, "")
  if (!needle) return false
  return text.split(/\r?\n/).some((line) => {
    const item = line.trim().toLowerCase()
    if (!item || item.startsWith("#")) return false
    return item.replace(/^@/, "") === needle
  })
}

function readJson(dir: string): Partial<ConnectionState> | null {
  const text = readText(dir, "connections.json")
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<ConnectionState>
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}
