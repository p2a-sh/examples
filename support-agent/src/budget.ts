import { utcDay } from "./limits.js"

export interface BudgetState {
  day: string
  spent: number
  reserved: number
  llmCalls: number
  alerted50: boolean
  alerted80: boolean
  paused: boolean
  operatorUnpaused: boolean
}

export function emptyBudget(now: Date): BudgetState {
  return {
    day: utcDay(now),
    spent: 0,
    reserved: 0,
    llmCalls: 0,
    alerted50: false,
    alerted80: false,
    paused: false,
    operatorUnpaused: false,
  }
}

export function worstCaseUsd(promptChars: number, maxOutputTokens: number, priceInPerM: number, priceOutPerM: number): number {
  const inputTokens = promptChars / 3
  return (inputTokens * priceInPerM + maxOutputTokens * priceOutPerM) / 1_000_000
}

export function usageUsd(promptTokens: number, outputTokens: number, priceInPerM: number, priceOutPerM: number): number {
  return (promptTokens * priceInPerM + outputTokens * priceOutPerM) / 1_000_000
}

export function rollBudget(state: BudgetState, now: Date): void {
  const day = utcDay(now)
  if (state.day === day) return
  state.day = day
  state.spent = 0
  state.reserved = 0
  state.llmCalls = 0
  state.alerted50 = false
  state.alerted80 = false
  state.paused = false
  state.operatorUnpaused = false
}

export function tryReserve(state: BudgetState, cost: number, limit: number, now: Date): boolean {
  rollBudget(state, now)
  if (state.operatorUnpaused) {
    state.reserved += cost
    return true
  }
  if (state.paused) return false
  if (state.spent + state.reserved + cost > limit) {
    state.paused = true
    return false
  }
  state.reserved += cost
  return true
}

export function settle(
  state: BudgetState,
  reservedCost: number,
  actual: number,
  limit: number,
  now: Date,
  notify: (event: "budget_50" | "budget_80") => void,
): void {
  rollBudget(state, now)
  state.reserved = Math.max(0, state.reserved - reservedCost)
  state.spent += actual
  const ratio = limit > 0 ? state.spent / limit : 1
  if (!state.alerted50 && ratio >= 0.5) {
    state.alerted50 = true
    notify("budget_50")
  }
  if (!state.alerted80 && ratio >= 0.8) {
    state.alerted80 = true
    notify("budget_80")
  }
  if (state.spent >= limit && !state.operatorUnpaused) state.paused = true
}

export function releaseReserve(state: BudgetState, reservedCost: number): void {
  state.reserved = Math.max(0, state.reserved - reservedCost)
}
