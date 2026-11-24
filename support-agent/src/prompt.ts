import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ChatMessage } from "./llm.js"
import { readText, writeTextAtomic } from "./state.js"

export function packagedPromptPath(): string {
  return fileURLToPath(new URL("../prompts/system.md", import.meta.url))
}

export function loadSystemPrompt(path: string, product: string): string {
  const raw = readFileSync(path, "utf8")
  return raw.replaceAll("{PRODUCT}", product).trim()
}

export function ensureCanary(dir: string): string {
  const existing = readText(dir, "canary")?.trim()
  if (existing) return existing
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  const bytes = randomBytes(24)
  let value = ""
  for (const byte of bytes) value += alphabet[byte % alphabet.length]
  writeTextAtomic(dir, "canary", value)
  return value
}

export function buildMessages(options: {
  instructions: string
  canary: string
  message: string
  docs: { source: string; text: string }[]
}): { messages: ChatMessage[]; effectivePrompt: string } {
  const effectivePrompt = `${options.instructions}\n\n${options.canary}`
  const docs = options.docs.map((doc) => `<docs source="${escapeAttr(doc.source)}">${escapeAngles(doc.text)}</docs>`).join("\n")
  const user = `<user_message>${escapeAngles(options.message)}</user_message>`
  return {
    effectivePrompt,
    messages: [
      { role: "system", content: effectivePrompt },
      { role: "user", content: docs ? `${docs}\n${user}` : user },
    ],
  }
}

function escapeAngles(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttr(text: string): string {
  return escapeAngles(text).replaceAll('"', "&quot;")
}
