import type { ReportKind } from "./classify.js"
import type { Config } from "./config.js"

export function contact(config: Config): string {
  return config.escalationContact || "the operator of this agent"
}

export function pausedText(config: Config): string {
  const extra = config.escalationContact ? `, or contact ${config.escalationContact}` : ""
  return `${config.productName} support is paused right now. Please try again later${extra}.`
}

export function blockedText(config: Config): string {
  const extra = config.escalationContact ? ` Contact ${config.escalationContact}.` : ""
  return `This agent can't help you.${extra}`
}

export function offTopicText(config: Config): string {
  return `I only answer questions about using ${config.productName}: setup, guides and the SDK. For anything else, please use your own assistant.`
}

export function oversizeText(config: Config): string {
  const limit = config.maxInputChars.toLocaleString("en-US")
  return `Please keep questions under ${limit} characters. Paste only the error line or the step you're stuck on.`
}

export function limitText(limit: number, unit: string, retryMinutes: number): string {
  return `You've reached the support limit (${limit} per ${unit}). Try again in about ${retryMinutes} minutes.`
}

export function longThreadText(config: Config): string {
  const extra = config.escalationContact ? `, or contact ${config.escalationContact}` : ""
  return `This conversation is long. Start a new one${extra}.`
}

export function retryText(config: Config): string {
  return `${config.productName} support could not answer just now. Please try again.`
}

export function escalationText(
  config: Config,
  category: "account" | "billing" | "security" | "abuse" | "legal",
): string {
  const who = contact(config)
  if (category === "account") {
    return `Account changes need a person. Email ${who} from the address you signed up with. I've let the team know someone asked.`
  }
  if (category === "billing") return `Billing questions go to ${who}. I've let the team know.`
  if (category === "security") {
    return `Thanks. Please email ${who} with 'Security' in the subject. Don't include secrets. If a token leaked, revoke it now on your agent's page.`
  }
  if (category === "legal") return `Legal questions need a person. Email ${who}. I've let the team know.`
  return `Please email ${who} with the agent address involved. I've let the team know.`
}

function trackedAs(config: Config, identifier: string, url?: string): string {
  if (config.linearShowUrls && url && /^https:\/\//i.test(url)) return `${identifier} (${url})`
  return identifier
}

export function linearTrackedText(config: Config, identifier: string, url?: string): string {
  return `This is already tracked as ${trackedAs(config, identifier, url)}. I added the new report there.`
}

export function linearDuplicateText(config: Config, identifier: string, url?: string): string {
  return `This is already tracked as ${trackedAs(config, identifier, url)}.`
}

const KIND_REPLY: Record<ReportKind, string> = {
  bug: "a bug",
  feature: "a feature request",
  feedback: "feedback",
}

export function linearCreatedText(config: Config, identifier: string, url: string | undefined, kind: ReportKind): string {
  return `I opened ${trackedAs(config, identifier, url)} as ${KIND_REPLY[kind]}.`
}

export function linearCappedText(config: Config): string {
  return `I can't open another report today. Email ${contact(config)}.`
}

export function linearFailedText(config: Config): string {
  return `I couldn't file that report. Email ${contact(config)}.`
}

export function linearUnusableText(config: Config): string {
  return `Please describe the problem without secrets or personal details. Email ${contact(config)} if you need a person.`
}

const CLARIFY_PROMPTS: Record<string, string> = {
  surface: "which page, screen, tool, or endpoint you were using",
  action: "what you did just before it happened",
  expected: "what you expected to happen",
  actual: "what happened instead, including any error text",
  repro: "how often it happens and the steps to reproduce it",
  scope: "which agent or client you used, and when it started",
}

const FILE_OPTION = 'You can answer, or reply "file it" to file this as written.'

export function withFileOption(question: string): string {
  const body = question.trim()
  if (/\bfile it\b/i.test(body)) return body.slice(0, 600)
  const extra = ` ${FILE_OPTION}`
  const base = body || "What is the problem, or the change you want?"
  const room = 600 - extra.length
  const trimmed = base.length > room ? `${base.slice(0, Math.max(0, room - 1)).trimEnd()}…` : base
  return `${trimmed}${extra}`
}

export function clarifyQuestionText(missing: readonly string[]): string {
  const ask = missing.filter((item) => CLARIFY_PROMPTS[item]).slice(0, 2)
  const first = CLARIFY_PROMPTS[ask[0] ?? ""]
  const body = ask.length === 0
    ? "What is the problem, or the change you want?"
    : ask.length === 1
      ? `Please tell me ${first}.`
      : `Please tell me ${first}, and ${CLARIFY_PROMPTS[ask[1] ?? ""]}.`
  return withFileOption(body)
}

export function linearNeedsInfoText(text: string): string {
  return `${text}\nI filed it as needs-info.`
}
