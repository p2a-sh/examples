import { mentionsProduct } from "./retrieve.js"

export type EscalationCategory = "account" | "billing" | "security" | "abuse" | "legal"

export type Classification =
  | { kind: "support" }
  | { kind: "off_topic" }
  | { kind: "escalate"; category: EscalationCategory }

const ESCALATIONS: { category: EscalationCategory; pattern: RegExp }[] = [
  { category: "account", pattern: /\bdelete my (account|data)\b|\blost\b.{0,40}\b(access|account)\b|\bcan'?t (log|sign) in\b/i },
  { category: "billing", pattern: /\b(charged|billing|invoice|payment)\b/i },
  { category: "security", pattern: /\bxss\b|\bvulnerability\b|\bsecurity (bug|issue|problem|report)\b|\bexploit\b/i },
  { category: "abuse", pattern: /\b(spam|harassment|abusive)\b/i },
  { category: "legal", pattern: /\b(lawsuit|lawyer|subpoena|gdpr|legal notice)\b/i },
]

const OFF_TOPIC = [
  /\btranslate\b/i,
  /\b(essay|poem|story)\b/i,
  /ignore previous/i,
  /you are now/i,
  /repeat your instructions/i,
  /\bact as\b/i,
]

const GENERIC_CODE = /\b(python|javascript|typescript|react|scraper)\b/i

const BUG_REPORT = [
  /\b(bug|bugs|crash(?:es|ed|ing)?|broken|regression)\b/i,
  /\b(not working|doesn'?t work|does not work|isn'?t working|is not working)\b/i,
  /\b(fails|failing|failed) to\b/i,
  /\b(problem|issue) (with|in|when)\b/i,
]

const FEATURE = [
  /\bfeature request\b/i,
  /\b(?:please|can you|could you)\s+add\b/i,
  /\bi have a suggestion\b/i,
  /\benhancement request\b/i,
  /\bwould be nice\b/i,
]

const FEEDBACK = [
  /\bfeedback(?:\s+on|\s+about|:)/i,
  /\b(?:my|some|this) feedback\b/i,
]

const FEATURE_OR_FEEDBACK = [...FEATURE, ...FEEDBACK]

export type ReportKind = "bug" | "feature" | "feedback"

/** Obvious reports are classified here. A bug symptom wins over a feature or feedback phrase. */
export function reportKind(text: string): ReportKind {
  if (isBugReport(text)) return "bug"
  if (FEATURE.some((pattern) => pattern.test(text))) return "feature"
  if (FEEDBACK.some((pattern) => pattern.test(text))) return "feedback"
  return "bug"
}

export function isBugReport(text: string): boolean {
  if (/\bhow (do|can|to)\b/i.test(text)) return false
  return BUG_REPORT.some((pattern) => pattern.test(text))
}

export function isProductReport(text: string): boolean {
  if (/\bhow (do|can|to)\b/i.test(text)) return false
  if (isBugReport(text)) return true
  return FEATURE_OR_FEEDBACK.some((pattern) => pattern.test(text))
}

export function classifyMessage(text: string, retrievalOffTopic: boolean): Classification {
  for (const item of ESCALATIONS) {
    if (item.pattern.test(text)) return { kind: "escalate", category: item.category }
  }
  if (OFF_TOPIC.some((pattern) => pattern.test(text))) return { kind: "off_topic" }
  if (GENERIC_CODE.test(text) && !mentionsProduct(text)) return { kind: "off_topic" }
  if (retrievalOffTopic) return { kind: "off_topic" }
  return { kind: "support" }
}
