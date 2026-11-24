import { redactSecrets } from "./scan.js"

const LINK = /https?:\/\/[^\s<>)\]]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const EXTRA_LINKS = ["https://www.npmjs.com/package/p2a-sdk", "https://npmjs.com/package/p2a-sdk", "https://pypi.org/project/p2a-sdk"]

export function filterOutput(text: string, options: {
  canary: string
  prompt: string
  allowedLinkPrefixes: string[]
  allowedEmails: string[]
  maxChars: number
  replacement: string
}): { text: string; leaked: boolean } {
  if ((options.canary && text.includes(options.canary)) || leaksPrompt(text, options.prompt)) {
    return { text: options.replacement, leaked: true }
  }
  let cleaned = redactSecrets(text)
  cleaned = cleaned.replace(LINK, (link) => (allowedLink(link, options.allowedLinkPrefixes) ? link : "[link removed]"))
  const allowed = new Set(options.allowedEmails.map((item) => item.toLowerCase()))
  cleaned = cleaned.replace(EMAIL, (email) => (allowed.has(email.toLowerCase()) ? email : "[email removed]"))
  return { text: shorten(cleaned, options.maxChars), leaked: false }
}

export function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"))
  const cut = sentence > maxChars * 0.5 ? slice.slice(0, sentence + 1).trimEnd() : slice.trimEnd()
  return `${cut}…(shortened)`
}

function allowedLink(link: string, prefixes: string[]): boolean {
  const trimmed = link.replace(/[.,;:]+$/, "")
  if (prefixes.some((prefix) => prefix && trimmed.startsWith(prefix))) return true
  return EXTRA_LINKS.some((allowed) => trimmed.startsWith(allowed))
}

function leaksPrompt(output: string, prompt: string): boolean {
  if (prompt.length < 40) return false
  for (let index = 0; index + 40 <= prompt.length; index += 1) {
    const sample = prompt.slice(index, index + 40)
    const letters = sample.replace(/[^A-Za-z]/g, "")
    if (letters.length < 20) continue
    if (output.includes(sample)) return true
  }
  return false
}
