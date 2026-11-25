import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { BundleFile } from "./bundle.js"
import {
  emptyBudget,
  releaseReserve,
  rollBudget,
  settle,
  tryReserve,
  usageUsd,
  worstCaseUsd,
  type BudgetState,
} from "./budget.js"
import { givesUp, isHowToQuestion, judgeClarity, wantsFiled, withoutFilingDirective } from "./clarify.js"
import { classifyMessage, isBugReport, isProductReport, reportKind, type EscalationCategory, type ReportKind } from "./classify.js"
import type { Config } from "./config.js"
import { cleanSummary, fileBugReport, linearClientFor, runJudgeModel, senderKey, type FileResult, type LinearClient, type LinearIssue } from "./linear.js"
import { withKey } from "./locks.js"
import { PENDING_CAP, readPending, upsertPending, type PendingReport } from "./pending.js"
import { filterOutput } from "./filter.js"
import { completeChat, type Completion } from "./llm.js"
import { dayMovedForward, emptyBuckets, takeLimit, utcDay, type Buckets } from "./limits.js"
import { logLine } from "./log.js"
import { buildMessages, ensureCanary, loadSystemPrompt, packagedPromptPath } from "./prompt.js"
import {
  blockedText,
  escalationText,
  limitText,
  longThreadText,
  offTopicText,
  oversizeText,
  linearFailedText,
  pausedText,
  retryText,
} from "./replies.js"
import { indexBundle, loadCachedBundle, mentionsProduct, retrieve } from "./retrieve.js"
import { fileExists, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./state.js"

export interface TurnState {
  buckets: Buckets
  budget: BudgetState
  injectionLeaks: number
  recentReplies: { id: string; text: string }[]
  burstWindowMs?: number
}

export type TurnReason =
  | "paused"
  | "blocked"
  | "limited"
  | "long_thread"
  | "oversize"
  | "escalate"
  | "off_topic"
  | "answer"
  | "leak"
  | "error"

export interface TurnResult {
  text: string
  outcome: "completed"
  reason: TurnReason
  category?: EscalationCategory
  llmCalls: number
}

export function emptyTurnState(now: Date): TurnState {
  return { buckets: emptyBuckets(), budget: emptyBudget(now), injectionLeaks: 0, recentReplies: [] }
}

export function loadTurnState(dir: string, now: Date, burstWindowMs?: number): TurnState {
  const state = emptyTurnState(now)
  if (burstWindowMs && burstWindowMs > 0) state.burstWindowMs = burstWindowMs
  const saved = budgetFrom(readJson<unknown>(dir, "budget.json"))
  const hadReserve = saved !== null && saved.reserved > 0
  if (saved) {
    saved.reserved = 0
    state.budget = saved
  }
  const dropped = applyCounters(state, readJson<unknown>(dir, "counters.json"), now)
  const dayBefore = state.budget.day
  const pausedBefore = state.budget.paused
  syncBudget(state.budget, dir, now)
  const rolled = state.budget.day !== dayBefore
  if (rolled) {
    state.buckets.daily.clear()
    state.buckets.bursts.clear()
  }
  if (saved && (rolled || pausedBefore !== state.budget.paused || dropped || hadReserve)) {
    persist(dir, state, now)
  }
  return state
}

const EMPTY_BUNDLE: BundleFile = {
  version: "none",
  builderVersion: "1",
  builtAt: "",
  sources: [],
  chunks: [],
}

export async function handleTurn(input: {
  config: Config
  state: TurnState
  message: string
  did: string
  senderDid?: string
  requestId?: string
  owner: string
  contextId: string
  now: Date
  clock?: () => Date
  bundle?: BundleFile | null
  turn?: number
  previousUser?: string
  fetchImpl?: typeof fetch
  onEvent?: (event: string) => void
  linear?: LinearClient
  judge?: (summary: string, issues: { id: string; identifier: string; title: string; description: string; url: string }[]) => Promise<string | null>
}): Promise<TurnResult> {
  const config = input.config
  const turn = input.turn ?? 1
  syncBudget(input.state.budget, config.stateDir, stamp(input))
  input.state.burstWindowMs = config.senderBurstWindowSeconds * 1000
  if (fileExists(config.stateDir, "KILL") || !config.enabled) {
    return finish(input, pausedText(config), "paused")
  }
  if (ownerBlocked(config.stateDir, input.owner)) {
    return finish(input, blockedText(config), "blocked")
  }
  if (input.requestId) {
    const prior = input.state.recentReplies.find((item) => item.id === input.requestId)
    if (prior) return done(prior.text, "answer")
  }
  // An allowlisted relay DID is limited per conversation. Every other sender, including a failed resolve, is limited per DID.
  const bucket = relayBucket(input.did, input.contextId, config.relayDids)
  const limit = takeLimit(input.state.buckets, {
    did: bucket ?? input.did,
    owner: (bucket ?? input.owner).toLowerCase(),
    contextId: input.contextId,
    now: stamp(input),
    burst: config.senderBurst,
    burstWindowSeconds: config.senderBurstWindowSeconds,
    senderPerDay: config.senderPerDay,
    ownerPerDay: config.ownerPerDay,
    contextPerDay: config.contextTurnsPerDay,
  })
  if (!limit.ok) {
    if (limit.scope === "context_day") return finish(input, longThreadText(config), "long_thread")
    return finish(input, limitText(limit.limit ?? 0, limit.unit ?? "day", limit.retryMinutes ?? 1), "limited")
  }
  persist(config.stateDir, input.state, stamp(input))
  if (input.message.length > config.maxInputChars) return finish(input, oversizeText(config), "oversize")
  const early = classifyMessage(input.message, false)
  if (early.kind === "escalate") {
    input.onEvent?.(`escalate:${early.category}`)
    return { ...finish(input, escalationText(config, early.category), "escalate"), category: early.category }
  }
  if (early.kind === "off_topic") {
    const continued = await maybeFileBug(input, true)
    if (continued) return continued
    return finish(input, offTopicText(config), "off_topic")
  }
  const filed = await maybeFileBug(input, false)
  if (filed) return filed
  const loaded = input.bundle
    ? { bundle: input.bundle, index: indexBundle(input.bundle) }
    : loadCachedBundle(config.stateDir)
  const bundle = loaded?.bundle ?? EMPTY_BUNDLE
  const index = loaded?.index ?? indexBundle(bundle)
  const retrieval = retrieve(bundle, index, input.message, {
    topK: config.topK,
    contextTokens: config.contextTokens,
    minScore: config.minScore,
    previousUser: input.previousUser,
  })
  if (retrieval.offTopic) return finish(input, offTopicText(config), "off_topic")
  const prompt = assembledPrompt(config, input.message, retrieval.chunks.map((chunk) => ({ source: chunk.source, text: chunk.text })))
  if (budgetPaused(input.state.budget, config) || input.state.budget.llmCalls >= config.globalLlmPerDay) {
    return finish(input, pausedText(config), "paused")
  }
  input.state.budget.llmCalls += 1
  const reserved = worstCaseUsd(prompt.chars, config.maxOutputTokens, config.llmPriceInPerM, config.llmPriceOutPerM)
  if (!tryReserve(input.state.budget, reserved, config.dailyBudgetUsd, stamp(input))) {
    input.state.budget.llmCalls -= 1
    return finish(input, pausedText(config), "paused")
  }
  let completion: Completion
  try {
    completion = await ask(config, prompt.messages, input.fetchImpl)
  } catch {
    releaseReserve(input.state.budget, reserved)
    persist(config.stateDir, input.state, stamp(input))
    return finish(input, retryText(config), "error", 1)
  }
  const actual = completion.usage
    ? usageUsd(completion.usage.promptTokens, completion.usage.outputTokens, config.llmPriceInPerM, config.llmPriceOutPerM)
    : reserved
  settle(input.state.budget, reserved, completion.errorCode ? reserved : actual, config.dailyBudgetUsd, stamp(input), (event) => {
    input.onEvent?.(event)
  })
  if (input.state.budget.paused) writeBudgetPause(config.stateDir)
  persist(config.stateDir, input.state, stamp(input))
  if (completion.errorCode || !completion.text.trim()) {
    return finish(input, retryText(config), "error", 1)
  }
  const filtered = filterOutput(completion.text, {
    canary: prompt.canary,
    prompt: prompt.effectivePrompt,
    allowedLinkPrefixes: config.allowedLinkPrefixes,
    allowedEmails: config.allowedEmails,
    maxChars: config.maxReplyChars,
    replacement: offTopicText(config),
  })
  if (filtered.leaked) {
    input.state.injectionLeaks += 1
    logLine("warn", "injection_leak", { count: input.state.injectionLeaks }, config.logLevel)
    persist(config.stateDir, input.state, stamp(input))
  }
  return finish(input, filtered.text, filtered.leaked ? "leak" : "answer", 1)
}

type BugInput = {
  config: Config
  state: TurnState
  message: string
  did: string
  senderDid?: string
  requestId?: string
  contextId?: string
  now: Date
  clock?: () => Date
  fetchImpl?: typeof fetch
  onEvent?: (event: string) => void
  linear?: LinearClient
  judge?: (summary: string, issues: { id: string; identifier: string; title: string; description: string; url: string }[]) => Promise<string | null>
}

async function maybeFileBug(input: BugInput, followUpOnly: boolean): Promise<TurnResult | null> {
  if (!input.config.linearEnabled) return null
  if (!input.senderDid) {
    if (followUpOnly) return null
    return legacyFileBug(input)
  }
  if (isHowToQuestion(input.message)) return null
  // An allowlisted relay DID keeps each conversation's report separate. Direct senders share one report.
  const key = senderKey(reporterOf(input))
  return withKey(key, () => clarifyLocked(input, key, followUpOnly))
}

async function legacyFileBug(input: BugInput): Promise<TurnResult | null> {
  const config = input.config
  if (!shouldFile(input.message)) return null
  if (budgetPaused(input.state.budget, config) || input.state.budget.llmCalls >= config.globalLlmPerDay) {
    return finish(input, pausedText(config), "paused")
  }
  const result = await runFile(input, {
    did: input.did,
    summary: input.message,
    facts: [input.message],
    missing: [],
    needsInfo: false,
    meterJudge: true,
  })
  return result.turn
}

async function clarifyLocked(input: BugInput, key: string, followUpOnly: boolean): Promise<TurnResult | null> {
  const config = input.config
  const ttlMs = config.clarifyTtlHours * 60 * 60 * 1000
  const snapshot = await readPending(config.stateDir, stamp(input), ttlMs, config.logLevel)
  const existing = snapshot.find((entry) => entry.key === key) ?? null
  if (existing?.lastReply && input.requestId && existing.lastReply.requestId === input.requestId) {
    logLine("info", "clarify_idempotent", {
      count: existing.rounds,
      category: existing.lastReply.outcome === "needs_info" ? "needs_info" : `missing:${existing.missing.length}`,
    }, config.logLevel)
    return finish(input, existing.lastReply.text, "answer")
  }
  if (existing?.state === "asking") return advanceReport(input, key, existing, false)
  if (followUpOnly) return null
  if (!shouldFile(input.message)) return null
  const atCap = snapshot.length >= PENDING_CAP && !snapshot.some((entry) => entry.key === key)
  return advanceReport(input, key, null, atCap)
}

async function advanceReport(input: BugInput, key: string, existing: PendingReport | null, forceFile: boolean): Promise<TurnResult> {
  const config = input.config
  const fact = existing ? followUpFact(input.message) : cleanSummary(input.message)
  const facts = existing ? pushFacts(existing.facts, fact) : fact ? [fact] : []
  const rounds = existing?.rounds ?? 0
  const judgment = await judgeClarity({
    config,
    budget: input.state.budget,
    facts,
    now: stamp(input),
    clock: input.clock,
    fetchImpl: input.fetchImpl,
    persist: () => persist(config.stateDir, input.state, stamp(input)),
    onBudgetPause: () => writeBudgetPause(config.stateDir),
    onEvent: input.onEvent,
  })
  const askLimit = Math.min(config.clarifyMaxRounds, 1)
  const fileNow = forceFile || judgment.clear || givesUp(input.message) || wantsFiled(input.message) || rounds >= askLimit
  if (!fileNow) {
    const text = judgment.question.slice(0, 600)
    const entry: PendingReport = {
      key,
      requestIds: rememberIds(existing?.requestIds ?? [], input.requestId),
      facts,
      missing: judgment.missing,
      rounds: rounds + 1,
      createdAt: existing?.createdAt ?? stamp(input).getTime(),
      updatedAt: stamp(input).getTime(),
      state: "asking",
      lastReply: { requestId: input.requestId ?? "", outcome: "asked", text },
    }
    await upsertPending(config.stateDir, stamp(input), config.clarifyTtlHours * 60 * 60 * 1000, config.logLevel, entry)
    logLine("info", "clarify_asked", { count: entry.rounds, category: `missing:${entry.missing.length}` }, config.logLevel)
    return finish(input, text, "answer", judgment.llmCalls)
  }
  const needsInfo = !judgment.clear
  const kind = reportKind(facts.join("\n"))
  const filed = await runFile(input, {
    did: reporterOf(input),
    summary: facts[0] ?? "",
    facts,
    missing: judgment.missing,
    needsInfo,
    meterJudge: modelAllowed(input),
    kind,
    suggestedTitle: judgment.title,
  })
  const stored = filed.result.action === "created" || filed.result.action === "commented" || filed.result.action === "duplicate"
  if (stored && !(forceFile && !existing)) {
    const entry: PendingReport = {
      key,
      requestIds: rememberIds(existing?.requestIds ?? [], input.requestId),
      facts,
      missing: judgment.missing,
      rounds,
      createdAt: existing?.createdAt ?? stamp(input).getTime(),
      updatedAt: stamp(input).getTime(),
      state: "filed",
      identifier: filed.result.identifier,
      lastReply: {
        requestId: input.requestId ?? "",
        outcome: needsInfo ? "needs_info" : "filed",
        text: filed.result.text.slice(0, 600),
      },
    }
    await upsertPending(config.stateDir, stamp(input), config.clarifyTtlHours * 60 * 60 * 1000, config.logLevel, entry)
  }
  if (stored) {
    logLine("info", "report_filed", {
      count: rounds,
      category: needsInfo ? "needs_info" : `missing:${judgment.missing.length}`,
      clarified: existing?.state === "asking",
      kind,
    }, config.logLevel)
  }
  return finish(input, filed.turn.text, filed.turn.reason, judgment.llmCalls + filed.turn.llmCalls)
}

async function runFile(input: BugInput, report: {
  did: string
  summary: string
  facts: string[]
  missing: string[]
  needsInfo: boolean
  meterJudge: boolean
  kind?: ReportKind
  suggestedTitle?: string
}): Promise<{ result: FileResult; turn: TurnResult }> {
  const config = input.config
  const metered = report.meterJudge && !input.judge
  try {
    const client = input.linear ?? linearClientFor(config, input.fetchImpl ?? fetch)
    const judge = report.meterJudge
      ? (input.judge ?? ((summary, issues) => meteredJudge(input, summary, issues)))
      : async () => null
    const result = await fileBugReport({
      config,
      did: report.did,
      summary: report.summary,
      facts: report.facts,
      missing: report.missing,
      needsInfo: report.needsInfo,
      meterJudge: report.meterJudge,
      kind: report.kind,
      suggestedTitle: report.suggestedTitle,
      now: stamp(input),
      client,
      judge,
    })
    if (result.judged && !metered) {
      input.state.budget.llmCalls += 1
      persist(config.stateDir, input.state, stamp(input))
    }
    return {
      result,
      turn: finish(input, result.text, result.action === "failed" ? "error" : "answer", result.judged ? 1 : 0),
    }
  } catch {
    logLine("warn", "linear_failed", { error_code: "linear_failed" }, config.logLevel)
    const turn = finish(input, linearFailedText(config), "error")
    return { result: { text: turn.text, action: "failed", judged: false }, turn }
  }
}

function reporterOf(input: BugInput): string {
  const did = input.senderDid || input.did
  const contextId = input.contextId ?? ""
  if (relayBucket(did, contextId, input.config.relayDids)) return `${did}\n${contextId}`
  return did
}

function relayBucket(did: string, contextId: string, relays: readonly string[]): string | undefined {
  const needle = did.trim()
  if (!needle || needle === "unknown" || !relays.includes(needle)) return undefined
  if (!contextId || contextId === needle) return undefined
  return `${needle}#${contextId}`
}

function stamp(input: { now: Date; clock?: () => Date }): Date {
  const value = input.clock?.()
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  return input.now
}

async function meteredJudge(input: BugInput, summary: string, issues: LinearIssue[]): Promise<string | null> {
  const config = input.config
  const promptChars = summary.length + issues.reduce((sum, issue) => sum + issue.identifier.length + issue.title.length + issue.description.length, 0) + 600
  const reserved = worstCaseUsd(promptChars, config.maxOutputTokens, config.llmPriceInPerM, config.llmPriceOutPerM)
  if (input.state.budget.llmCalls >= config.globalLlmPerDay) throw new Error("linear_failed")
  input.state.budget.llmCalls += 1
  if (!tryReserve(input.state.budget, reserved, config.dailyBudgetUsd, stamp(input))) {
    input.state.budget.llmCalls -= 1
    throw new Error("linear_failed")
  }
  let outcome: Awaited<ReturnType<typeof runJudgeModel>>
  try {
    outcome = await runJudgeModel(config, summary, issues, input.fetchImpl)
  } catch {
    releaseReserve(input.state.budget, reserved)
    persist(config.stateDir, input.state, stamp(input))
    throw new Error("linear_failed")
  }
  const actual = outcome.usage
    ? usageUsd(outcome.usage.promptTokens, outcome.usage.outputTokens, config.llmPriceInPerM, config.llmPriceOutPerM)
    : reserved
  settle(
    input.state.budget,
    reserved,
    outcome.errorCode ? reserved : actual,
    config.dailyBudgetUsd,
    stamp(input),
    (event) => input.onEvent?.(event),
  )
  if (input.state.budget.paused) writeBudgetPause(config.stateDir)
  persist(config.stateDir, input.state, stamp(input))
  if (outcome.failed) throw new Error("linear_failed")
  return outcome.identifier
}

function modelAllowed(input: BugInput): boolean {
  if (budgetPaused(input.state.budget, input.config)) return false
  if (input.state.budget.llmCalls >= input.config.globalLlmPerDay) return false
  return Boolean(input.config.llmApiKey)
}

function shouldFile(text: string): boolean {
  if (!isProductReport(text)) return false
  if (isBugReport(text)) return mentionsProduct(text)
  return true
}

function followUpFact(message: string): string {
  if (!wantsFiled(message)) return cleanSummary(message)
  const stripped = withoutFilingDirective(message)
  if (stripped.replace(/[^A-Za-z]/g, "").length < 8) return ""
  return cleanSummary(message)
}

function pushFacts(facts: string[], fact: string): string[] {
  if (!fact) return facts.slice(0, 4)
  const next = [...facts, fact]
  if (next.length <= 4) return next
  return [next[0] ?? "", ...next.slice(next.length - 3)].filter((item) => item.length > 0).slice(0, 4)
}

function rememberIds(ids: string[], requestId: string | undefined): string[] {
  const current = ids.filter((id) => id.length > 0)
  if (!requestId || current.includes(requestId)) return current.slice(0, 6)
  const next = [...current, requestId]
  return next.length > 6 ? next.slice(next.length - 6) : next
}

function done(text: string, reason: TurnReason, llmCalls = 0): TurnResult {
  return { text, outcome: "completed", reason, llmCalls }
}

function finish(
  input: { requestId?: string; state: TurnState; config: Config; now: Date; clock?: () => Date },
  text: string,
  reason: TurnReason,
  llmCalls = 0,
): TurnResult {
  if (input.requestId && reason !== "error") {
    rememberReply(input.state, input.requestId, text)
    persist(input.config.stateDir, input.state, stamp(input))
  }
  return done(text, reason, llmCalls)
}

function rememberReply(state: TurnState, requestId: string, text: string): void {
  const id = requestId.slice(0, 200)
  if (!id) return
  const replies = state.recentReplies
  const existing = replies.findIndex((item) => item.id === id)
  if (existing >= 0) replies.splice(existing, 1)
  replies.push({ id, text: text.slice(0, 3500) })
  if (replies.length > 32) replies.splice(0, replies.length - 32)
}

function budgetPaused(budget: BudgetState, config: Config): boolean {
  if (fileExists(config.stateDir, "PAUSED")) return true
  if (budget.operatorUnpaused) return false
  return budget.paused
}

function syncBudget(budget: BudgetState, dir: string, now: Date): void {
  if (dayMovedForward(budget.day, now)) {
    const marker = readText(dir, "PAUSED")
    rollBudget(budget, now)
    if (marker?.trim() === "budget") rmSync(join(dir, "PAUSED"), { force: true })
    return
  }
  if (budget.paused && !fileExists(dir, "PAUSED")) {
    budget.paused = false
    budget.operatorUnpaused = true
  }
}

function writeBudgetPause(dir: string): void {
  if (!fileExists(dir, "PAUSED")) writeTextAtomic(dir, "PAUSED", "budget\n")
}

function budgetFrom(value: unknown): BudgetState | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null
  return {
    day: raw.day,
    spent: nonNeg(raw.spent),
    reserved: nonNeg(raw.reserved),
    llmCalls: nonNeg(raw.llmCalls),
    alerted50: raw.alerted50 === true,
    alerted80: raw.alerted80 === true,
    paused: raw.paused === true,
    operatorUnpaused: raw.operatorUnpaused === true,
  }
}

function applyCounters(state: TurnState, value: unknown, now: Date): boolean {
  if (!value || typeof value !== "object") return false
  const raw = value as {
    injection_leak?: unknown
    daily?: unknown
    bursts?: unknown
    replies?: unknown
  }
  if (typeof raw.injection_leak === "number" && raw.injection_leak >= 0 && Number.isFinite(raw.injection_leak)) {
    state.injectionLeaks = Math.floor(raw.injection_leak)
  }
  let dropped = false
  const today = utcDay(now)
  if (raw.daily && typeof raw.daily === "object") {
    for (const [key, entry] of Object.entries(raw.daily as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") {
        dropped = true
        continue
      }
      const item = entry as { day?: unknown; count?: unknown }
      const day = typeof item.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.day) ? item.day : ""
      if (!safeLimitKey(key) || !day || day < today || nonNeg(item.count) <= 0) {
        dropped = true
        continue
      }
      state.buckets.daily.set(key, { day, count: Math.floor(nonNeg(item.count)) })
    }
  }
  const cutoff = now.getTime() - burstWindowMs(state)
  if (raw.bursts && typeof raw.bursts === "object") {
    for (const [key, stamps] of Object.entries(raw.bursts as Record<string, unknown>)) {
      if (!safeLimitKey(key) || !Array.isArray(stamps)) {
        dropped = true
        continue
      }
      const kept = stamps.filter((stamp): stamp is number => typeof stamp === "number" && stamp >= cutoff)
      if (kept.length !== stamps.length) dropped = true
      if (kept.length) state.buckets.bursts.set(key, kept)
    }
  }
  if (Array.isArray(raw.replies)) {
    const replies: { id: string; text: string }[] = []
    for (const item of raw.replies) {
      if (!item || typeof item !== "object") continue
      const reply = item as { id?: unknown; text?: unknown }
      if (typeof reply.id !== "string" || typeof reply.text !== "string") continue
      if (!reply.id || reply.id.length > 200 || reply.text.length > 3500) continue
      replies.push({ id: reply.id, text: reply.text })
    }
    state.recentReplies = replies.slice(-32)
  }
  return dropped
}

function nonNeg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function safeLimitKey(key: string): boolean {
  return /^(sender|owner|context|did):[^@\r\n]{1,200}$/.test(key)
}

function persist(dir: string, state: TurnState, now: Date): void {
  const today = utcDay(now)
  const daily: Record<string, { day: string; count: number }> = {}
  for (const [key, value] of state.buckets.daily) {
    if (value.day < today) {
      state.buckets.daily.delete(key)
      continue
    }
    if (safeLimitKey(key)) daily[key] = { day: value.day, count: value.count }
  }
  const cutoff = now.getTime() - burstWindowMs(state)
  const bursts: Record<string, number[]> = {}
  for (const [key, stamps] of state.buckets.bursts) {
    const kept = stamps.filter((stamp) => stamp >= cutoff)
    if (kept.length === 0) {
      state.buckets.bursts.delete(key)
      continue
    }
    if (kept.length !== stamps.length) state.buckets.bursts.set(key, kept)
    if (safeLimitKey(key)) bursts[key] = kept
  }
  writeJsonAtomic(dir, "budget.json", state.budget)
  writeJsonAtomic(dir, "counters.json", {
    llm_calls: state.budget.llmCalls,
    injection_leak: state.injectionLeaks,
    daily,
    bursts,
    replies: state.recentReplies.slice(-32),
  })
}

function burstWindowMs(state: TurnState): number {
  return state.burstWindowMs && state.burstWindowMs > 0 ? state.burstWindowMs : 24 * 60 * 60 * 1000
}

function ownerBlocked(dir: string, owner: string): boolean {
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

function assembledPrompt(config: Config, message: string, docs: { source: string; text: string }[]) {
  const instructions = loadSystemPrompt(config.promptFile || packagedPromptPath(), config.productName)
  const canary = ensureCanary(config.stateDir)
  const built = buildMessages({ instructions, canary, message, docs })
  return {
    ...built,
    canary,
    chars: built.messages.reduce((sum, item) => sum + item.content.length, 0),
    promptVersion: createHash("sha256").update(instructions).digest("hex").slice(0, 12),
  }
}

async function ask(config: Config, messages: { role: "system" | "user" | "assistant"; content: string }[], fetchImpl?: typeof fetch): Promise<Completion> {
  if (!config.llmApiKey) return { text: "", provider: "primary", errorCode: "llm_failed" }
  return completeChat({
    primary: {
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      apiKey: config.llmApiKey,
      timeoutMs: config.llmTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    },
    messages,
    fetchImpl,
    logLevel: config.logLevel,
  })
}
