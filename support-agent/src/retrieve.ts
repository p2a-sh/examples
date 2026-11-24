import { buildIndex, search, type Bm25Index } from "./bm25.js"
import type { BundleChunk, BundleFile } from "./bundle.js"

export const PRODUCT_TERMS = [
  "p2a",
  "agent",
  "mcp",
  "grok",
  "chatgpt",
  "claude",
  "instinct",
  "sdk",
  "token",
  "connect",
  "wake",
  "guide",
  "owner",
  "alias",
  "artifact",
  "brief",
  "plan",
]

export interface Retrieval {
  chunks: BundleChunk[]
  best: number
  offTopic: boolean
}

export function indexBundle(bundle: BundleFile): Bm25Index {
  return buildIndex(bundle.chunks.map((chunk) => ({ id: chunk.id, text: `${chunk.title}\n${chunk.text}` })))
}

export function buildQuery(message: string, previousUser?: string): string {
  const parts = [previousUser ?? "", message].map((item) => item.trim()).filter(Boolean)
  return parts.join("\n").slice(0, 600)
}

export function retrieve(
  bundle: BundleFile,
  index: Bm25Index,
  message: string,
  options: { topK: number; contextTokens: number; minScore: number; previousUser?: string },
): Retrieval {
  const query = buildQuery(message, options.previousUser)
  const hits = search(index, query, options.topK)
  const byId = new Map(bundle.chunks.map((chunk) => [chunk.id, chunk]))
  const best = hits[0]?.score ?? 0
  const offTopic = best < options.minScore && !mentionsProduct(message)
  const chunks: BundleChunk[] = []
  let tokens = 0
  for (const hit of hits) {
    const chunk = byId.get(hit.id)
    if (!chunk) continue
    const cost = Math.ceil(chunk.text.length / 4)
    if (chunks.length && tokens + cost > options.contextTokens) break
    chunks.push(chunk)
    tokens += cost
  }
  return { chunks: offTopic ? [] : chunks, best, offTopic }
}

export function mentionsProduct(message: string): boolean {
  const folded = message.toLowerCase()
  return PRODUCT_TERMS.some((term) => new RegExp(`(?:^|[^a-z0-9])${term}(?:[^a-z0-9]|$)`).test(folded))
}
