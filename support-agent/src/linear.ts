import { createHash } from "node:crypto"
import { reportKind, type ReportKind } from "./classify.js"
import type { Config } from "./config.js"
import { utcDay } from "./limits.js"
import { completeChat, type TokenUsage } from "./llm.js"
import { withKey } from "./locks.js"
import { logLine } from "./log.js"
import {
  linearCappedText,
  linearCreatedText,
  linearDuplicateText,
  linearFailedText,
  linearNeedsInfoText,
  linearTrackedText,
  linearUnusableText,
} from "./replies.js"
import { redactSecrets } from "./scan.js"
import { readJson, writeJsonAtomic } from "./state.js"

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql"
export const LINEAR_DAILY_CAP = 20
export const LINEAR_DEDUPE_MS = 24 * 60 * 60 * 1000

const IDENTIFIER = /^[A-Z][A-Z0-9]+-\d+$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const DID = /\bdid:[a-z0-9]+:[a-z0-9._:-]+/gi
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const PHONE = /(?:\+\d{1,3}[\s-])?(?:\(\d{3}\)|\d{3})[\s-]\d{3}[\s-]\d{4}\b/g
const NAME = /\b[Mm]y name is\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g
const ASSIGNED_SECRET = /(?<=^|[^A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|token|key)\s*[:=]\s*\S+/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g

class LinearCallError extends Error {
  readonly labelRejected: boolean
  readonly timedOut: boolean
  readonly status?: number
  readonly graphqlCode?: string

  constructor(detail: { labelRejected?: boolean; timedOut?: boolean; status?: number; graphqlCode?: string } = {}) {
    super("linear_failed")
    this.name = "LinearCallError"
    this.labelRejected = detail.labelRejected === true
    this.timedOut = detail.timedOut === true
    if (typeof detail.status === "number" && detail.status >= 100 && detail.status <= 599) this.status = detail.status
    if (detail.graphqlCode && /^[A-Za-z0-9_]{1,40}$/.test(detail.graphqlCode)) this.graphqlCode = detail.graphqlCode
  }
}

const SEARCH_QUERY = `query SearchOpen($term: String!, $team: String!) {
  searchIssues(
    term: $term
    first: 5
    filter: {
      team: { key: { eq: $team } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes { id identifier title description url }
  }
}`

const TEAM_QUERY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { id }
  }
}`

const LABEL_QUERY = `query LabelByName($name: String!, $team: String!) {
  issueLabels(
    filter: {
      name: { eqIgnoreCase: $name }
      or: [
        { team: { key: { eq: $team } } }
        { team: { null: true } }
      ]
    }
    first: 10
  ) {
    nodes { id name team { key } }
  }
}`

const NEEDS_INFO_LABEL = "needs-info"

const COMMENT_QUERY = `mutation Comment($id: String!, $body: String!) {
  commentCreate(input: { issueId: $id, body: $body }) {
    success
  }
}`

const CREATE_QUERY = `mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title description url }
  }
}`

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string
  url: string
}

export interface LinearClient {
  searchOpen(term: string): Promise<LinearIssue[]>
  comment(issueId: string, body: string): Promise<void>
  create(title: string, description: string, options?: { needsInfo?: boolean; id?: string; label?: string }): Promise<LinearIssue>
}

export type FileAction = "commented" | "created" | "duplicate" | "capped" | "unusable" | "failed"

export interface FileResult {
  text: string
  action: FileAction
  judged: boolean
  identifier?: string
}

type Judge = (summary: string, issues: LinearIssue[]) => Promise<string | null>

interface SeenReport {
  sender: string
  hash: string
  identifier: string
  url?: string
  at: number
}

interface LinearState {
  day: string
  created: number
  comments: number
  seen: SeenReport[]
  pending?: { hash: string; title: string }
}

interface RawIssue {
  id?: string
  identifier?: string
  title?: string
  description?: string | null
  url?: string | null
}

const DESCRIPTION_MAX = 2500
const RUBRIC_NAMES = ["surface", "action", "expected", "actual", "repro", "scope"]

export function cleanSummary(text: string): string {
  const cleaned = redactSecrets(text)
    .replace(EMAIL, "[redacted]")
    .replace(DID, "[redacted]")
    .replace(UUID, "[redacted]")
    .replace(PHONE, "[redacted]")
    .replace(NAME, "[redacted]")
    .replace(JWT, "[redacted]")
    .replace(IPV4, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(ASSIGNED_SECRET, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= 500) return cleaned
  return `${cleaned.slice(0, 499).trimEnd()}…`
}

export const ISSUE_TITLE_MAX = 70

const TITLE_GREETING = /^(?:good morning|good afternoon|good evening|thank you|thanks|hello|hiya|howdy|hey|hi)\b(?:\s+(?:there|team|all|folks))?[,!:\-–—\s]*/i
const TITLE_FROM_EMAIL = /^from\s+\S+@\S+(?:\s+\([^)]{0,80}\))?\s*[:,–—-]?\s*/i
const TITLE_FROM = /^from\s+[^:\n]{1,120}:\s*/i
const TITLE_NOTE = /^\((?=[^)]{0,80}\b(?:test(?:ing)?|safe to close|ignore|fyi|draft|wip)\b)[^)]{0,80}\)\s*[:,–—-]?\s*/i
const TITLE_KIND = /^(?:bug(?:\s+report)?|feature(?:[-\s]+request)?|feedback)\s*:\s*/i

export function issueTitle(summary: string): string {
  return cleanedTitleBody(summary, ISSUE_TITLE_MAX)
}

/** One kind prefix plus a short summary. A usable model title wins; otherwise the report is cleaned. */
export function formatIssueTitle(kind: ReportKind, summary: string, suggested?: string): string {
  const prefix = kind === "feature" ? "Feature: " : kind === "feedback" ? "Feedback: " : "Bug: "
  const room = Math.max(8, ISSUE_TITLE_MAX - prefix.length)
  const model = acceptSuggestedTitle(suggested, room)
  const body = model || cleanedTitleBody(summary, room)
  const safe = usableTitle(body) ? body : "support report"
  return `${prefix}${safe}`
}

const clientCache = new WeakMap<object, { marker: string; client: LinearClient }>()

export function linearClientFor(config: Config, fetchImpl: typeof fetch = fetch): LinearClient {
  const marker = [
    config.linearTeamKey ?? "",
    config.linearApiKey ?? "",
    config.linearBugLabel,
    config.linearFeatureLabel,
    config.linearFeedbackLabel,
  ].join("\0")
  const hit = clientCache.get(fetchImpl)
  if (hit && hit.marker === marker) return hit.client
  const client = createLinearClient(config, fetchImpl)
  clientCache.set(fetchImpl, { marker, client })
  return client
}

export function createLinearClient(config: Config, fetchImpl: typeof fetch = fetch): LinearClient {
  const key = config.linearApiKey ?? ""
  const team = config.linearTeamKey ?? ""
  let teamId: string | undefined
  const labelCache = new Map<string, string | null>()

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
      throw new LinearCallError({ timedOut })
    }
    if (!response.ok) throw new LinearCallError({ status: response.status })
    let payload: { data?: T; errors?: unknown[] }
    try {
      payload = (await response.json()) as { data?: T; errors?: unknown[] }
    } catch {
      throw new LinearCallError({ status: response.status })
    }
    if (payload.errors?.length || payload.data === undefined) {
      throw new LinearCallError({
        labelRejected: isLabelRejection(payload.errors),
        graphqlCode: graphqlCode(payload.errors),
        status: response.status,
      })
    }
    return payload.data
  }

  async function lookupLabel(name: string): Promise<string | null> {
    const cacheKey = name.trim().toLowerCase()
    if (!cacheKey) return null
    if (labelCache.has(cacheKey)) return labelCache.get(cacheKey) ?? null
    try {
      const data = await gql<{ issueLabels?: { nodes?: { id?: string; name?: string; team?: { key?: string | null } | null }[] } }>(
        LABEL_QUERY,
        { team, name },
      )
      const id = pickLabel(data.issueLabels?.nodes ?? [], team, name)
      labelCache.set(cacheKey, id)
      return id
    } catch {
      // A lookup failure still opens the issue, and the next create tries the label again.
      return null
    }
  }

  async function createdIssue(input: Record<string, unknown>): Promise<LinearIssue> {
    const data = await gql<{ issueCreate?: { success?: boolean; issue?: RawIssue } }>(CREATE_QUERY, { input })
    const issue = data.issueCreate?.success ? asIssue(data.issueCreate.issue ?? {}) : null
    if (!issue) throw new LinearCallError()
    return issue
  }

  async function adoptByTitle(title: string): Promise<LinearIssue | null> {
    try {
      const data = await gql<{ searchIssues?: { nodes?: RawIssue[] } }>(SEARCH_QUERY, { term: title.slice(0, 80), team })
      for (const node of data.searchIssues?.nodes ?? []) {
        const issue = asIssue(node)
        if (issue && sameTitle(issue.title, title)) return issue
      }
    } catch {
      return null
    }
    return null
  }

  return {
    async searchOpen(term: string): Promise<LinearIssue[]> {
      const data = await gql<{ searchIssues?: { nodes?: RawIssue[] } }>(SEARCH_QUERY, { term, team })
      return (data.searchIssues?.nodes ?? []).flatMap((node) => {
        const issue = asIssue(node)
        return issue ? [issue] : []
      })
    },
    async comment(issueId: string, body: string): Promise<void> {
      const data = await gql<{ commentCreate?: { success?: boolean } }>(COMMENT_QUERY, { id: issueId, body })
      if (!data.commentCreate?.success) throw new Error("linear_failed")
    },
    async create(title: string, description: string, options?: { needsInfo?: boolean; id?: string; label?: string }): Promise<LinearIssue> {
      if (!teamId) {
        const data = await gql<{ teams?: { nodes?: { id?: string }[] } }>(TEAM_QUERY, { key: team })
        teamId = data.teams?.nodes?.[0]?.id
        if (!teamId) throw new Error("linear_failed")
      }
      const labelNames = [options?.label ?? config.linearBugLabel]
      if (options?.needsInfo) labelNames.push(NEEDS_INFO_LABEL)
      const labels: string[] = []
      for (const name of labelNames) {
        const id = await lookupLabel(name)
        if (id && !labels.includes(id)) labels.push(id)
      }
      const input: Record<string, unknown> = { teamId, title, description }
      if (options?.id) input.id = options.id
      if (labels.length > 0) input.labelIds = labels
      try {
        return await createdIssue(input)
      } catch (err) {
        if (err instanceof LinearCallError && err.labelRejected && labels.length > 0) {
          for (const name of labelNames) labelCache.set(name.trim().toLowerCase(), null)
          try {
            return await createdIssue({ teamId, title, description, ...(options?.id ? { id: options.id } : {}) })
          } catch (retryErr) {
            if (retryErr instanceof LinearCallError && retryErr.timedOut) {
              const adopted = await adoptByTitle(title)
              if (adopted) return adopted
            }
            throw retryErr
          }
        }
        if (err instanceof LinearCallError && err.timedOut) {
          const adopted = await adoptByTitle(title)
          if (adopted) return adopted
        }
        throw err
      }
    },
  }
}

export interface JudgeOutcome {
  identifier: string | null
  failed: boolean
  errorCode?: "llm_failed" | "llm_timeout"
  usage?: TokenUsage
}

export async function runJudgeModel(
  config: Config,
  summary: string,
  issues: LinearIssue[],
  fetchImpl?: typeof fetch,
): Promise<JudgeOutcome> {
  if (!config.llmApiKey || issues.length === 0) return { identifier: null, failed: true, errorCode: "llm_failed" }
  const allowed = new Set(issues.map((issue) => issue.identifier))
  const list = issues
    .map((issue) => `${issue.identifier}: ${oneLine(issue.title)}\n${oneLine(issue.description)}`)
    .join("\n\n")
  const completion = await completeChat({
    primary: {
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      apiKey: config.llmApiKey,
      timeoutMs: config.llmTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    },
    messages: [
      {
        role: "system",
        content:
          'You match a support report to an open issue. Reply with JSON only: {"identifier":null} when none is the same problem, or {"identifier":"ID"} using an identifier from the list.',
      },
      { role: "user", content: `Report:\n${summary}\n\nOpen issues:\n${list}` },
    ],
    fetchImpl,
    logLevel: config.logLevel,
  })
  if (completion.errorCode) {
    return { identifier: null, failed: true, errorCode: completion.errorCode, usage: completion.usage }
  }
  const parsed = parseJudge(completion.text, allowed)
  if (parsed === "bad") return { identifier: null, failed: true, usage: completion.usage }
  if (parsed === "none") return { identifier: null, failed: false, usage: completion.usage }
  return { identifier: parsed, failed: false, usage: completion.usage }
}

export async function judgeWithModel(
  config: Config,
  summary: string,
  issues: LinearIssue[],
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  const outcome = await runJudgeModel(config, summary, issues, fetchImpl)
  if (outcome.failed) throw new Error("linear_failed")
  return outcome.identifier
}

export function fileBugReport(input: {
  config: Config
  did: string
  now: Date
  client: LinearClient
  judge: Judge
  message?: string
  summary?: string
  facts?: string[]
  missing?: string[]
  needsInfo?: boolean
  meterJudge?: boolean
  kind?: ReportKind
  suggestedTitle?: string
}): Promise<FileResult> {
  return withKey("linear", () => fileBugReportInner(input))
}

async function fileBugReportInner(input: {
  config: Config
  did: string
  now: Date
  client: LinearClient
  judge: Judge
  message?: string
  summary?: string
  facts?: string[]
  missing?: string[]
  needsInfo?: boolean
  meterJudge?: boolean
  kind?: ReportKind
  suggestedTitle?: string
}): Promise<FileResult> {
  const facts = input.facts && input.facts.length > 0 ? input.facts : input.message ? [input.message] : []
  const summary = cleanSummary(input.summary ?? facts[0] ?? "")
  const description = reportDescription(facts.length > 0 ? facts : [summary], input.missing ?? [])
  const needsInfo = input.needsInfo === true
  const kind = input.kind ?? reportKind([summary, ...facts].join("\n"))
  const pack = (text: string, action: FileAction, judged: boolean, identifier?: string): FileResult => {
    const shown = needsInfo && (action === "created" || action === "commented" || action === "duplicate")
      ? linearNeedsInfoText(text)
      : text
    return { text: shown, action, judged, identifier }
  }
  if (!usable(summary)) return pack(linearUnusableText(input.config), "unusable", false)
  const state = loadState(input.config.stateDir, input.now)
  const hash = reportHash(summary)
  const sender = senderKey(input.did)
  const prior = state.seen.find((item) => item.sender === sender && item.hash === hash)
  if (prior && IDENTIFIER.test(prior.identifier)) {
    saveState(input.config.stateDir, state)
    return pack(linearDuplicateText(input.config, prior.identifier, prior.url), "duplicate", false, prior.identifier)
  }
  let candidates: LinearIssue[] = []
  try {
    candidates = (await input.client.searchOpen(searchTerm(summary))).slice(0, 5)
  } catch {
    fail(input.config, "search")
    return pack(linearFailedText(input.config), "failed", false)
  }
  let judged = false
  let match: string | null = null
  if (candidates.length > 0 && input.meterJudge !== false) {
    judged = true
    try {
      match = await input.judge(summary, candidates)
    } catch {
      // A judge failure must not open a second issue for a problem we could not compare.
      fail(input.config, "judge")
      return pack(linearFailedText(input.config), "failed", true)
    }
    if (match && !candidates.some((issue) => issue.identifier === match)) {
      fail(input.config, "judge")
      return pack(linearFailedText(input.config), "failed", true)
    }
  }
  const matched = match ? candidates.find((issue) => issue.identifier === match) : undefined
  if (matched) {
    if (state.comments >= LINEAR_DAILY_CAP) {
      saveState(input.config.stateDir, state)
      return pack(linearCappedText(input.config), "capped", judged)
    }
    try {
      await input.client.comment(matched.id, description)
    } catch (err) {
      fail(input.config, "comment", failureDetail(err))
      return pack(linearFailedText(input.config), "failed", judged)
    }
    state.comments += 1
    remember(state, sender, hash, matched, input.now)
    saveState(input.config.stateDir, state)
    return pack(linearTrackedText(input.config, matched.identifier, matched.url), "commented", judged, matched.identifier)
  }
  const title = formatIssueTitle(kind, summary, input.suggestedTitle)
  if (state.pending?.hash === hash) {
    try {
      const adopted = (await input.client.searchOpen(title)).find((issue) => sameTitle(issue.title, title))
      if (adopted && IDENTIFIER.test(adopted.identifier)) {
        state.pending = undefined
        remember(state, sender, hash, adopted, input.now)
        saveState(input.config.stateDir, state)
        return pack(linearDuplicateText(input.config, adopted.identifier, adopted.url), "duplicate", false, adopted.identifier)
      }
    } catch (err) {
      fail(input.config, "search", failureDetail(err))
    }
  }
  if (state.created >= LINEAR_DAILY_CAP) {
    saveState(input.config.stateDir, state)
    return pack(linearCappedText(input.config), "capped", judged)
  }
  state.pending = { hash, title }
  saveState(input.config.stateDir, state)
  let created: LinearIssue
  try {
    created = await input.client.create(title, description, {
      ...(needsInfo ? { needsInfo: true } : {}),
      id: issueUuid(hash),
      label: labelForKind(input.config, kind),
    })
  } catch (err) {
    fail(input.config, "create", failureDetail(err))
    return pack(linearFailedText(input.config), "failed", judged)
  }
  if (!IDENTIFIER.test(created.identifier)) {
    state.created += 1
    saveState(input.config.stateDir, state)
    fail(input.config, "create")
    return pack(linearFailedText(input.config), "failed", judged)
  }
  state.created += 1
  state.pending = undefined
  remember(state, sender, hash, created, input.now)
  saveState(input.config.stateDir, state)
  return pack(linearCreatedText(input.config, created.identifier, created.url, kind), "created", judged, created.identifier)
}

function labelForKind(config: Config, kind: ReportKind): string {
  if (kind === "feature") return config.linearFeatureLabel
  if (kind === "feedback") return config.linearFeedbackLabel
  return config.linearBugLabel
}

function acceptSuggestedTitle(suggested: string | undefined, max: number): string {
  if (!suggested) return ""
  if (/@|https?:\/\/|\bdid:/i.test(suggested)) return ""
  if (/clear enough to file|reply with json|untrusted data/i.test(suggested)) return ""
  const body = cleanedTitleBody(suggested, max)
  return usableTitle(body) ? body : ""
}

function cleanedTitleBody(text: string, max: number): string {
  const stripped = stripTitlePreamble(text)
  const redacted = cleanSummary(stripped)
    .replace(/\[redacted\]/g, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return clipTitle(firstSentence(redacted), max)
}

function stripTitlePreamble(text: string): string {
  let current = text.replace(/\s+/g, " ").trim()
  for (let pass = 0; pass < 6; pass += 1) {
    const next = current
      .replace(TITLE_GREETING, "")
      .replace(TITLE_FROM_EMAIL, "")
      .replace(TITLE_FROM, "")
      .replace(TITLE_NOTE, "")
      .replace(TITLE_KIND, "")
      .replace(/^[\s:;–—-]+/, "")
      .trim()
    if (next === current) return current
    current = next
  }
  return current
}

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s/)[0] ?? text).trim()
}

function clipTitle(text: string, max: number): string {
  if (max < 1 || !text) return ""
  if (text.length <= max) return text
  if (max === 1) return "…"
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  const base = space >= Math.floor(max * 0.5) ? cut.slice(0, space) : cut
  return `${base.trimEnd()}…`
}

function usableTitle(text: string): boolean {
  return text.replace(/[^A-Za-z]/g, "").length >= 4
}

function pickLabel(
  nodes: { id?: string; name?: string; team?: { key?: string | null } | null }[],
  teamKey: string,
  expected: string,
): string | null {
  const want = expected.trim().toLowerCase()
  const named = nodes.filter((node) => node.id && (node.name ?? "").trim().toLowerCase() === want)
  const team = named.find((node) => (node.team?.key ?? "").trim().toLowerCase() === teamKey.trim().toLowerCase())
  if (team?.id) return team.id
  const workspace = named.find((node) => !node.team?.key)
  return workspace?.id ?? null
}

function reportDescription(facts: string[], missing: string[]): string {
  const lines = facts.map((fact) => cleanSummary(fact)).filter((fact) => fact.length > 0)
  const known = missing.filter((item) => RUBRIC_NAMES.includes(item))
  if (known.length > 0) lines.push(`Missing: ${known.join(", ")}`)
  const text = lines.join("\n")
  if (text.length <= DESCRIPTION_MAX) return text
  return `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
}

function remember(state: LinearState, sender: string, hash: string, issue: LinearIssue, now: Date): void {
  state.seen.push({
    sender,
    hash,
    identifier: issue.identifier,
    url: issue.url || undefined,
    at: now.getTime(),
  })
}

function sameTitle(left: string, right: string): boolean {
  return left.replace(/\s+/g, " ").trim().toLowerCase() === right.replace(/\s+/g, " ").trim().toLowerCase()
}

function issueUuid(hash: string): string {
  const h = hash.padEnd(32, "0")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function graphqlCode(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined
  for (const err of errors) {
    if (!err || typeof err !== "object") continue
    const code = (err as { extensions?: { code?: unknown } }).extensions?.code
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code
  }
  return undefined
}

function failureDetail(err: unknown): { status?: number; code?: string } | undefined {
  if (!(err instanceof LinearCallError)) return undefined
  return { status: err.status, code: err.graphqlCode }
}

function isLabelRejection(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false
  return errors.some((err) => {
    if (!err || typeof err !== "object") return false
    const record = err as { message?: unknown; path?: unknown; extensions?: { validationErrors?: unknown } }
    if (pathHasLabel(record.path)) return true
    const validation = record.extensions?.validationErrors
    if (Array.isArray(validation)) {
      for (const item of validation) {
        if (item && typeof item === "object" && pathHasLabel((item as { path?: unknown }).path)) return true
      }
    }
    const message = typeof record.message === "string" ? record.message : ""
    return message.length > 0 && message.length <= 200 && /\blabel(?:s|Ids)?\b/i.test(message)
  })
}

function pathHasLabel(path: unknown): boolean {
  return Array.isArray(path) && path.some((part) => typeof part === "string" && part.toLowerCase().includes("label"))
}

function fail(config: Config, stage: string, detail?: { status?: number; code?: string }): void {
  const code = detail?.code && /^[A-Za-z0-9_]{1,40}$/.test(detail.code) ? detail.code : "linear_failed"
  const fields: Record<string, string | number> = { error_code: code, category: stage }
  if (typeof detail?.status === "number" && detail.status >= 100 && detail.status <= 599) fields.status = detail.status
  logLine("warn", "linear_failed", fields, config.logLevel)
}

function usable(summary: string): boolean {
  return summary.replace(/\[redacted\]/g, "").replace(/[^A-Za-z]/g, "").length >= 8
}

function searchTerm(summary: string): string {
  const words = summary
    .replace(/\[redacted\]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)
    .slice(0, 8)
  return words.join(" ") || summary.slice(0, 80)
}

function reportHash(summary: string): string {
  const norm = summary.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  return createHash("sha256").update(norm).digest("hex")
}

export function senderKey(did: string): string {
  return createHash("sha256").update(did).digest("hex")
}

function loadState(dir: string, now: Date): LinearState {
  const day = utcDay(now)
  const raw = readJson<LinearState>(dir, "linear.json")
  const seen = (Array.isArray(raw?.seen) ? raw.seen : []).filter((item) => {
    return item && typeof item.identifier === "string" && typeof item.at === "number" && item.at >= now.getTime() - LINEAR_DEDUPE_MS
  })
  const pending = pendingOf(raw?.pending)
  if (!raw || raw.day !== day) return { day, created: 0, comments: 0, seen }
  return {
    day,
    created: Number.isFinite(raw.created) ? raw.created : 0,
    comments: Number.isFinite(raw.comments) ? raw.comments : 0,
    seen,
    ...(pending ? { pending } : {}),
  }
}

function pendingOf(value: unknown): { hash: string; title: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { hash?: unknown; title?: unknown }
  if (typeof raw.hash !== "string" || !/^[0-9a-f]{64}$/.test(raw.hash)) return undefined
  if (typeof raw.title !== "string" || raw.title.length === 0 || raw.title.length > 120) return undefined
  return { hash: raw.hash, title: raw.title }
}

function saveState(dir: string, state: LinearState): void {
  writeJsonAtomic(dir, "linear.json", state)
}

function asIssue(node: RawIssue): LinearIssue | null {
  if (!node.id || !node.identifier) return null
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? "",
    url: node.url ?? "",
  }
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length <= 240 ? line : `${line.slice(0, 239).trimEnd()}…`
}

function parseJudge(text: string, allowed: Set<string>): string | "none" | "bad" {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return "bad"
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return "bad"
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("identifier" in parsed)) return "bad"
  const identifier = (parsed as { identifier?: unknown }).identifier
  if (identifier === null) return "none"
  if (typeof identifier === "string" && allowed.has(identifier)) return identifier
  return "bad"
}
