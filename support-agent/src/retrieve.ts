import { statSync } from "node:fs"
import { join } from "node:path"
import { buildIndex, search, type Bm25Index } from "./bm25.js"
import type { BundleChunk, BundleFile } from "./bundle.js"
import { readJson } from "./state.js"

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

interface BundleCache {
  dir: string
  mtimeMs: number
  size: number
  bundle: BundleFile
  index: Bm25Index
}

let bundleCache: BundleCache | undefined

/** Read bundle.json once per mtime and reuse its BM25 index. Invalid files become an empty bundle. */
export function loadCachedBundle(dir: string): { bundle: BundleFile; index: Bm25Index } | null {
  let mtimeMs = 0
  let size = 0
  try {
    const stat = statSync(join(dir, "bundle.json"))
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    return null
  }
  if (bundleCache && bundleCache.dir === dir && bundleCache.mtimeMs === mtimeMs && bundleCache.size === size) {
    return { bundle: bundleCache.bundle, index: bundleCache.index }
  }
  const bundle = validBundle(readJson<unknown>(dir, "bundle.json")) ?? emptyCachedBundle()
  const index = indexBundle(bundle)
  bundleCache = { dir, mtimeMs, size, bundle, index }
  return { bundle, index }
}

function emptyCachedBundle(): BundleFile {
  return { version: "none", builderVersion: "1", builtAt: "", sources: [], chunks: [] }
}

function validBundle(value: unknown): BundleFile | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.version !== "string" || !Array.isArray(raw.chunks)) return null
  const chunks: BundleChunk[] = []
  for (const item of raw.chunks) {
    if (!item || typeof item !== "object") continue
    const chunk = item as Record<string, unknown>
    if (typeof chunk.id !== "string" || typeof chunk.source !== "string" || typeof chunk.text !== "string") continue
    if (chunk.id.length > 200 || chunk.source.length > 300 || chunk.text.length > 8000) continue
    chunks.push({
      id: chunk.id,
      source: chunk.source,
      url: typeof chunk.url === "string" ? chunk.url : chunk.source,
      title: typeof chunk.title === "string" ? chunk.title : "",
      text: chunk.text,
      kind: chunk.kind === "code" ? "code" : "doc",
    })
  }
  const sources = Array.isArray(raw.sources) ? raw.sources.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const source = item as Record<string, unknown>
    if (typeof source.source !== "string" || typeof source.sha256 !== "string") return []
    return [{ source: source.source, sha256: source.sha256, etag: typeof source.etag === "string" ? source.etag : undefined }]
  }) : []
  return {
    version: raw.version,
    builderVersion: typeof raw.builderVersion === "string" ? raw.builderVersion : "",
    builtAt: typeof raw.builtAt === "string" ? raw.builtAt : "",
    sources,
    chunks,
  }
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
