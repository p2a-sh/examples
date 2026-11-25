import { logLine, type LogLevel } from "./log.js"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface TokenUsage {
  promptTokens: number
  outputTokens: number
}

export interface Completion {
  text: string
  usage?: TokenUsage
  provider: "primary"
  finishReason?: string
  errorCode?: "llm_failed" | "llm_timeout"
}

export interface LlmRoute {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  maxOutputTokens: number
}

export async function completeChat(options: {
  primary: LlmRoute
  messages: ChatMessage[]
  fetchImpl?: typeof fetch
  logLevel?: LogLevel
}): Promise<Completion> {
  const fetchImpl = options.fetchImpl ?? fetch
  const primary = await attempt(options.primary, options.messages, fetchImpl, options.logLevel ?? "info")
  if (!primary.errorCode) return { ...primary, provider: "primary" }
  return { text: "", provider: "primary", errorCode: primary.errorCode }
}

async function attempt(
  route: LlmRoute,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
  logLevel: LogLevel,
  tries = 2,
): Promise<Omit<Completion, "provider">> {
  let errorCode: Completion["errorCode"] = "llm_failed"
  for (let tryNumber = 0; tryNumber < tries; tryNumber += 1) {
    if (tryNumber > 0) await delay(RETRY_BACKOFF_MS)
    try {
      const response = await fetchImpl(`${route.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${route.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: route.model,
          temperature: 0.2,
          max_tokens: route.maxOutputTokens,
          messages,
        }),
        signal: AbortSignal.timeout(route.timeoutMs),
      })
      if (response.status === 429 || response.status >= 500) {
        errorCode = "llm_failed"
        continue
      }
      if (!response.ok) {
        logLine("warn", "llm_failed", { error_code: "llm_failed" }, logLevel)
        return { text: "", errorCode: "llm_failed" }
      }
      const payload = await response.json() as {
        choices?: { finish_reason?: string; message?: { content?: string } }[]
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
          reasoning_tokens?: number
          completion_tokens_details?: { reasoning_tokens?: number }
        }
      }
      const text = payload.choices?.[0]?.message?.content ?? ""
      const finishReason = payload.choices?.[0]?.finish_reason
      if (!text.trim() || finishReason === "length") {
        logLine("warn", text.trim() ? "llm_truncated" : "llm_empty", { status: finishReason ?? "none" }, logLevel)
      }
      const usage = payload.usage
      if (!usage) return { text, finishReason }
      return {
        text,
        finishReason,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          outputTokens: outputTokens(usage),
        },
      }
    } catch (err) {
      errorCode = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "llm_timeout" : "llm_failed"
    }
  }
  logLine("warn", errorCode ?? "llm_failed", { error_code: errorCode ?? "llm_failed" }, logLevel)
  return { text: "", errorCode }
}

const RETRY_BACKOFF_MS = 50

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Billable output tokens. OpenAI-style providers (including deepseek-v4-pro) already
 * count reasoning inside completion_tokens and report it again in
 * completion_tokens_details.reasoning_tokens, so that detail is never added on top.
 * total_tokens - prompt_tokens is used when present because it is right whether or not
 * a provider includes reasoning in completion_tokens. A bare top-level reasoning_tokens
 * with no total is treated as separate and added.
 */
export function outputTokens(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  reasoning_tokens?: number
}): number {
  const completion = usage.completion_tokens ?? 0
  if (typeof usage.total_tokens === "number" && typeof usage.prompt_tokens === "number") {
    return Math.max(completion, usage.total_tokens - usage.prompt_tokens)
  }
  return completion + (usage.reasoning_tokens ?? 0)
}
