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
import { fileable, givesUp, isHowToQuestion, judgeClarity } from "./clarify.js"
import { classifyMessage, isBugReport, type EscalationCategory } from "./classify.js"
import type { Config } from "./config.js"
import { cleanSummary, createLinearClient, fileBugReport, judgeWithModel, senderKey, type FileResult, type LinearClient } from "./linear.js"
import { withKey } from "./locks.js"
import { PENDING_CAP, readPending, upsertPending, type PendingReport } from "./pending.js"
import { filterOutput } from "./filter.js"
import { completeChat, type Completion } from "./llm.js"
import { emptyBuckets, takeLimit, utcDay, type Buckets } from "./limits.js"
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
import { indexBundle, mentionsProduct, retrieve } from "./retrieve.js"
import { fileExists, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./state.js"

export interface TurnState {
  buckets: Buckets
  budget: BudgetState
  injectionLeaks: number
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
  return { buckets: emptyBuckets(), budget: emptyBudget(now), injectionLeaks: 0 }
}

export function loadTurnState(dir: string, now: Date): TurnState {
  const state = emptyTurnState(now)
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
  syncBudget(input.state.budget, config.stateDir, input.now)
  if (fileExists(config.stateDir, "KILL") || !config.enabled) {
    return done(pausedText(config), "paused")
  }
  if (ownerBlocked(config.stateDir, input.owner)) {
    return done(blockedText(config), "blocked")
  }
  const limit = takeLimit(input.state.buckets, {
    did: input.did,
    owner: input.owner.toLowerCase(),
    contextId: input.contextId,
    now: input.now,
    burst: config.senderBurst,
    burstWindowSeconds: config.senderBurstWindowSeconds,
    senderPerDay: config.senderPerDay,
    ownerPerDay: config.ownerPerDay,
    contextPerDay: config.contextTurnsPerDay,
  })
  if (!limit.ok) {
    if (limit.scope === "context_day") return done(longThreadText(config), "long_thread")
    return done(limitText(limit.limit ?? 0, limit.unit ?? "day", limit.retryMinutes ?? 1), "limited")
  }
  persist(config.stateDir, input.state, input.now)
  if (input.message.length > config.maxInputChars) return done(oversizeText(config), "oversize")
  const early = classifyMessage(input.message, false)
  if (early.kind === "escalate") {
    input.onEvent?.(`escalate:${early.category}`)
    return { ...done(escalationText(config, early.category), "escalate"), category: early.category }
  }
  if (early.kind === "off_topic") return done(offTopicText(config), "off_topic")
  const filed = await maybeFileBug(input)
  if (filed) return filed
  const bundle = input.bundle ?? EMPTY_BUNDLE
  const retrieval = retrieve(bundle, indexBundle(bundle), input.message, {
    topK: config.topK,
    contextTokens: config.contextTokens,
    minScore: config.minScore,
    previousUser: input.previousUser,
  })
  if (retrieval.offTopic) return done(offTopicText(config), "off_topic")
  const prompt = assembledPrompt(config, input.message, retrieval.chunks.map((chunk) => ({ source: chunk.source, text: chunk.text })))
  if (budgetPaused(input.state.budget, config) || input.state.budget.llmCalls >= config.globalLlmPerDay) {
    return done(pausedText(config), "paused")
  }
  const reserved = worstCaseUsd(prompt.chars, config.maxOutputTokens, config.llmPriceInPerM, config.llmPriceOutPerM)
  if (!tryReserve(input.state.budget, reserved, config.dailyBudgetUsd, input.now)) {
    writeBudgetPause(config.stateDir)
    persist(config.stateDir, input.state, input.now)
    return done(pausedText(config), "paused")
  }
  let completion: Completion
  try {
    completion = await ask(config, prompt.messages, input.fetchImpl)
  } catch {
    releaseReserve(input.state.budget, reserved)
    input.state.budget.llmCalls += 1
    persist(config.stateDir, input.state, input.now)
    return done(retryText(config), "error", 1)
  }
  input.state.budget.llmCalls += 1
  const prices = completion.provider === "fallback"
    ? { in: config.fallbackPriceInPerM ?? config.llmPriceInPerM, out: config.fallbackPriceOutPerM ?? config.llmPriceOutPerM }
    : { in: config.llmPriceInPerM, out: config.llmPriceOutPerM }
  const actual = completion.usage
    ? usageUsd(completion.usage.promptTokens, completion.usage.outputTokens, prices.in, prices.out)
    : reserved
  settle(input.state.budget, reserved, completion.errorCode ? reserved : actual, config.dailyBudgetUsd, input.now, (event) => {
    input.onEvent?.(event)
  })
  if (input.state.budget.paused) writeBudgetPause(config.stateDir)
  persist(config.stateDir, input.state, input.now)
  if (completion.errorCode || !completion.text.trim()) {
    return done(retryText(config), "error", 1)
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
    persist(config.stateDir, input.state, input.now)
  }
  return done(filtered.text, filtered.leaked ? "leak" : "answer", 1)
}

type BugInput = {
  config: Config
  state: TurnState
  message: string
  did: string
  senderDid?: string
  requestId?: string
  now: Date
  fetchImpl?: typeof fetch
  onEvent?: (event: string) => void
  linear?: LinearClient
  judge?: (summary: string, issues: { id: string; identifier: string; title: string; description: string; url: string }[]) => Promise<string | null>
}

async function maybeFileBug(input: BugInput): Promise<TurnResult | null> {
  if (!input.config.linearEnabled) return null
  if (!input.senderDid) return legacyFileBug(input)
  if (isHowToQuestion(input.message)) return null
  const key = senderKey(input.senderDid)
  return withKey(key, () => clarifyLocked(input, key))
}

async function legacyFileBug(input: BugInput): Promise<TurnResult | null> {
  const config = input.config
  if (!isBugReport(input.message) || !mentionsProduct(input.message)) return null
  if (budgetPaused(input.state.budget, config) || input.state.budget.llmCalls >= config.globalLlmPerDay) {
    return done(pausedText(config), "paused")
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

async function clarifyLocked(input: BugInput, key: string): Promise<TurnResult | null> {
  const config = input.config
  const ttlMs = config.clarifyTtlHours * 60 * 60 * 1000
  const snapshot = await readPending(config.stateDir, input.now, ttlMs, config.logLevel)
  const existing = snapshot.find((entry) => entry.key === key) ?? null
  if (existing?.lastReply && input.requestId && existing.requestIds.includes(input.requestId)) {
    logLine("info", "clarify_idempotent", {
      count: existing.rounds,
      category: existing.lastReply.outcome === "needs_info" ? "needs_info" : `missing:${existing.missing.length}`,
    }, config.logLevel)
    return done(existing.lastReply.text, "answer")
  }
  if (existing?.state === "asking") return advanceReport(input, key, existing, false)
  if (!isBugReport(input.message) || !mentionsProduct(input.message)) return null
  const atCap = snapshot.length >= PENDING_CAP && !snapshot.some((entry) => entry.key === key)
  return advanceReport(input, key, null, atCap)
}

async function advanceReport(input: BugInput, key: string, existing: PendingReport | null, forceFile: boolean): Promise<TurnResult> {
  const config = input.config
  const fact = cleanSummary(input.message)
  const facts = existing ? pushFacts(existing.facts, fact) : fact ? [fact] : []
  const rounds = existing?.rounds ?? 0
  const judgment = await judgeClarity({
    config,
    budget: input.state.budget,
    facts,
    now: input.now,
    fetchImpl: input.fetchImpl,
    persist: () => persist(config.stateDir, input.state, input.now),
    onBudgetPause: () => writeBudgetPause(config.stateDir),
    onEvent: input.onEvent,
  })
  const canFile = fileable(judgment.present)
  if (!forceFile && !canFile && !givesUp(input.message) && rounds < config.clarifyMaxRounds) {
    const text = judgment.question.slice(0, 600)
    const entry: PendingReport = {
      key,
      requestIds: rememberIds(existing?.requestIds ?? [], input.requestId),
      facts,
      missing: judgment.missing,
      rounds: rounds + 1,
      createdAt: existing?.createdAt ?? input.now.getTime(),
      updatedAt: input.now.getTime(),
      state: "asking",
      lastReply: { requestId: input.requestId ?? "", outcome: "asked", text },
    }
    await upsertPending(config.stateDir, input.now, config.clarifyTtlHours * 60 * 60 * 1000, config.logLevel, entry)
    logLine("info", "clarify_asked", { count: entry.rounds, category: `missing:${entry.missing.length}` }, config.logLevel)
    return done(text, "answer", judgment.llmCalls)
  }
  const needsInfo = !canFile
  const filed = await runFile(input, {
    did: input.senderDid || input.did,
    summary: facts[0] ?? "",
    facts,
    missing: judgment.missing,
    needsInfo,
    meterJudge: modelAllowed(input),
  })
  const stored = filed.result.action === "created" || filed.result.action === "commented" || filed.result.action === "duplicate"
  if (stored && !(forceFile && !existing)) {
    const entry: PendingReport = {
      key,
      requestIds: rememberIds(existing?.requestIds ?? [], input.requestId),
      facts,
      missing: judgment.missing,
      rounds,
      createdAt: existing?.createdAt ?? input.now.getTime(),
      updatedAt: input.now.getTime(),
      state: "filed",
      identifier: filed.result.identifier,
      lastReply: {
        requestId: input.requestId ?? "",
        outcome: needsInfo ? "needs_info" : "filed",
        text: filed.result.text.slice(0, 600),
      },
    }
    await upsertPending(config.stateDir, input.now, config.clarifyTtlHours * 60 * 60 * 1000, config.logLevel, entry)
  }
  if (stored) {
    logLine("info", "clarify_filed", {
      count: rounds,
      category: needsInfo ? "needs_info" : `missing:${judgment.missing.length}`,
    }, config.logLevel)
  }
  return done(filed.turn.text, filed.turn.reason, judgment.llmCalls + filed.turn.llmCalls)
}

async function runFile(input: BugInput, report: {
  did: string
  summary: string
  facts: string[]
  missing: string[]
  needsInfo: boolean
  meterJudge: boolean
}): Promise<{ result: FileResult; turn: TurnResult }> {
  const config = input.config
  try {
    const client = input.linear ?? createLinearClient(config, input.fetchImpl ?? fetch)
    const judge = report.meterJudge
      ? (input.judge ?? ((summary, issues) => judgeWithModel(config, summary, issues, input.fetchImpl)))
      : async () => null
    const result = await fileBugReport({
      config,
      did: report.did,
      summary: report.summary,
      facts: report.facts,
      missing: report.missing,
      needsInfo: report.needsInfo,
      meterJudge: report.meterJudge,
      now: input.now,
      client,
      judge,
    })
    if (result.judged) {
      input.state.budget.llmCalls += 1
      persist(config.stateDir, input.state, input.now)
    }
    return {
      result,
      turn: done(result.text, result.action === "failed" ? "error" : "answer", result.judged ? 1 : 0),
    }
  } catch {
    logLine("warn", "linear_failed", { error_code: "linear_failed" }, config.logLevel)
    const turn = done(linearFailedText(config), "error")
    return { result: { text: turn.text, action: "failed", judged: false }, turn }
  }
}

function modelAllowed(input: BugInput): boolean {
  if (budgetPaused(input.state.budget, input.config)) return false
  if (input.state.budget.llmCalls >= input.config.globalLlmPerDay) return false
  return Boolean(input.config.llmApiKey)
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

function budgetPaused(budget: BudgetState, config: Config): boolean {
  if (fileExists(config.stateDir, "PAUSED")) return true
  if (budget.operatorUnpaused) return false
  return budget.paused
}

function syncBudget(budget: BudgetState, dir: string, now: Date): void {
  if (utcDay(now) !== budget.day) {
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
      if (!safeLimitKey(key) || item.day !== today || nonNeg(item.count) <= 0) {
        dropped = true
        continue
      }
      state.buckets.daily.set(key, { day: today, count: Math.floor(nonNeg(item.count)) })
    }
  }
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000
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
    if (value.day !== today) {
      state.buckets.daily.delete(key)
      continue
    }
    if (safeLimitKey(key)) daily[key] = { day: value.day, count: value.count }
  }
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000
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
  })
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
  const primary = {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs,
    maxOutputTokens: config.maxOutputTokens,
  }
  const fallback = config.fallbackEnabled && config.openrouterApiKey && config.fallbackPriceInPerM !== undefined && config.fallbackPriceOutPerM !== undefined
    ? {
        baseUrl: config.fallbackBaseUrl,
        model: config.fallbackModel,
        apiKey: config.openrouterApiKey,
        timeoutMs: config.llmTimeoutMs,
        maxOutputTokens: config.maxOutputTokens,
      }
    : undefined
  return completeChat({ primary, fallback, messages, fetchImpl, logLevel: config.logLevel })
}
