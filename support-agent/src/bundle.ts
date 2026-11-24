import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { leakKind } from "./scan.js"

export const BUILDER_VERSION = "1"
const MAX_BYTES = 2 * 1024 * 1024
const CHUNK_CHARS = 1200
const CHUNK_OVERLAP = 150

export interface BundleSource {
  source: string
  sha256: string
  etag?: string
}

interface LoadedSource extends BundleSource {
  text: string
  reuseChunks: boolean
}

export interface BundleChunk {
  id: string
  source: string
  url: string
  title: string
  text: string
  kind: "doc" | "code"
}

export interface BundleFile {
  version: string
  builderVersion: string
  builtAt: string
  sources: BundleSource[]
  chunks: BundleChunk[]
}

export interface BuildWarning {
  file: string
}

export interface BuildResult {
  bundle: BundleFile | null
  rejected: boolean
  paused: boolean
  alert: boolean
  warnings: BuildWarning[]
  dropped: number
}

export interface BuildRequest {
  sourceUrls?: string[]
  docsDirs?: string[]
  docsInclude?: string[]
  docsExclude?: string[]
  docsBaseUrl?: string
  allowedEmails?: string[]
  strict?: boolean
  previous?: BundleFile | null
  fetchImpl?: typeof fetch
  now?: () => Date
}

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "py"])
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum|def)\s+/

export async function buildBundle(request: BuildRequest): Promise<BuildResult> {
  const include = request.docsInclude?.length ? request.docsInclude : ["md", "mdx", "txt", "html", "ts", "py"]
  const exclude = request.docsExclude ?? []
  const allowedEmails = request.allowedEmails ?? []
  const strict = request.strict === true
  const previous = request.previous ?? null
  const warnings: BuildWarning[] = []
  const loadedSources: LoadedSource[] = []

  for (const url of request.sourceUrls ?? []) {
    const prior = previous?.sources.find((item) => item.source === url)
    const loaded = await loadUrl(url, prior, previous, request.fetchImpl ?? fetch)
    if (loaded) loadedSources.push(loaded)
  }

  for (const dir of request.docsDirs ?? []) {
    for (const file of walkDocs(dir, include, exclude)) {
      let text: string
      try {
        const buf = readFileSync(file.abs)
        if (buf.length > MAX_BYTES) {
          warnings.push({ file: file.rel })
          continue
        }
        text = buf.toString("utf8")
      } catch {
        warnings.push({ file: file.rel })
        continue
      }
      if (looksLikeHtml(file.rel, text)) text = htmlToText(text)
      loadedSources.push({ source: file.rel, sha256: sha256(text), text, reuseChunks: false })
    }
  }

  const chunks: BundleChunk[] = []
  let dropped = 0
  let leak = false
  for (const source of loadedSources) {
    if (!source.reuseChunks && source.text && leakKind(source.text, allowedEmails)) {
      leak = true
      dropped += 1
      warnings.push({ file: source.source })
      if (strict) break
      continue
    }
    const pieces = source.reuseChunks
      ? (previous?.chunks.filter((chunk) => chunk.source === source.source) ?? [])
      : chunkSource(source, request.docsBaseUrl)
    for (const piece of pieces) {
      if (leakKind(piece.text, allowedEmails)) {
        leak = true
        dropped += 1
        warnings.push({ file: source.source })
        if (strict) break
        continue
      }
      chunks.push(piece)
    }
    if (strict && leak) break
  }

  if (strict && leak) {
    return {
      bundle: previous,
      rejected: true,
      paused: previous == null,
      alert: true,
      warnings,
      dropped,
    }
  }

  const sources = loadedSources.map(({ source, sha256: digest, etag }) => ({ source, sha256: digest, etag }))
  const bundle: BundleFile = {
    version: bundleVersion(sources),
    builderVersion: BUILDER_VERSION,
    builtAt: (request.now ?? (() => new Date()))().toISOString(),
    sources,
    chunks,
  }
  return { bundle, rejected: false, paused: false, alert: false, warnings, dropped }
}

export function bundleVersion(sources: { source: string; sha256: string }[]): string {
  const lines = [...sources]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((item) => `${item.source}\n${item.sha256}`)
  const hash = createHash("sha256")
  hash.update(BUILDER_VERSION)
  hash.update("\n")
  hash.update(lines.join("\n"))
  return hash.digest("hex").slice(0, 12)
}

async function loadUrl(
  url: string,
  prior: BundleSource | undefined,
  previous: BundleFile | null,
  fetchImpl: typeof fetch,
): Promise<LoadedSource | null> {
  const headers: Record<string, string> = {}
  if (prior?.etag) headers["if-none-match"] = prior.etag
  let response: Response
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) })
  } catch {
    return reuse(url, prior, previous)
  }
  if (response.status === 304 && prior) return reuse(url, prior, previous)
  if (response.status !== 200) return reuse(url, prior, previous)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES) return reuse(url, prior, previous)
  let text = new TextDecoder().decode(bytes)
  const type = response.headers.get("content-type") ?? ""
  if (looksLikeHtml(url, text) || type.includes("html")) text = htmlToText(text)
  const etag = response.headers.get("etag") ?? undefined
  return { source: url, sha256: sha256(text), etag, text, reuseChunks: false }
}

function reuse(url: string, prior: BundleSource | undefined, previous: BundleFile | null): LoadedSource | null {
  if (!prior || !previous?.chunks.some((chunk) => chunk.source === url)) return prior ? { ...prior, text: "", reuseChunks: true } : null
  return { ...prior, text: "", reuseChunks: true }
}

function walkDocs(root: string, include: string[], exclude: string[]): { rel: string; abs: string }[] {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return []
  }
  const found: { rel: string; abs: string }[] = []
  const visit = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(".")) continue
      const abs = join(dir, name)
      let listed
      try {
        listed = lstatSync(abs)
      } catch {
        continue
      }
      if (listed.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(abs)
        } catch {
          continue
        }
        if (!inside(rootReal, real)) continue
      }
      let info
      try {
        info = statSync(abs)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        visit(abs)
        continue
      }
      if (!info.isFile()) continue
      const rel = relative(root, abs).split(sep).join("/")
      if (!rel || rel.startsWith("..") || rel.startsWith("/")) continue
      if (!selected(rel, include, exclude)) continue
      found.push({ rel, abs })
    }
  }
  visit(root)
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return found
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function selected(rel: string, include: string[], exclude: string[]): boolean {
  if (exclude.some((pattern) => matches(rel, pattern))) return false
  if (!include.length) return true
  return include.some((pattern) => matches(rel, pattern))
}

function matches(rel: string, pattern: string): boolean {
  const cleaned = pattern.trim()
  if (!cleaned) return false
  if (cleaned.includes("*")) {
    const expression = "^" + cleaned.split("*").map(escapeRegExp).join(".*") + "$"
    return new RegExp(expression).test(rel) || new RegExp(expression).test(rel.split("/").pop() ?? rel)
  }
  const ext = cleaned.replace(/^\*\./, "").replace(/^\./, "").toLowerCase()
  return rel.toLowerCase().endsWith("." + ext)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function chunkSource(source: LoadedSource, docsBaseUrl: string | undefined): BundleChunk[] {
  const ext = source.source.split(".").pop()?.toLowerCase() ?? ""
  const url = source.source.startsWith("http://") || source.source.startsWith("https://")
    ? source.source
    : docsBaseUrl
      ? docsBaseUrl.replace(/\/$/, "") + "/" + source.source
      : source.source
  const kind: BundleChunk["kind"] = CODE_EXT.has(ext) ? "code" : "doc"
  const pieces = kind === "code" ? splitDeclarations(source.text) : splitMarkdown(source.text)
  return pieces.map((piece, index) => ({
    id: sha256(`${source.source}\n${index}\n${piece.title}\n${piece.text}`).slice(0, 16),
    source: source.source,
    url,
    title: piece.title,
    text: piece.text,
    kind,
  }))
}

function splitMarkdown(text: string): { title: string; text: string }[] {
  const lines = text.split(/\r?\n/)
  const sections: { title: string; body: string[] }[] = []
  let current = { title: "", body: [] as string[] }
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (current.body.some((item) => item.trim()) || current.title) sections.push(current)
      current = { title: heading[2].trim(), body: [] }
    } else {
      current.body.push(line)
    }
  }
  if (current.body.some((item) => item.trim()) || current.title) sections.push(current)
  if (!sections.length) sections.push({ title: "", body: [text] })
  const pieces: { title: string; text: string }[] = []
  for (const section of sections) {
    const body = section.body.join("\n").trim()
    const whole = section.title ? `# ${section.title}\n\n${body}` : body
    for (const part of windowText(whole)) pieces.push({ title: section.title, text: part })
  }
  return pieces.filter((piece) => piece.text.trim())
}

function splitDeclarations(text: string): { title: string; text: string }[] {
  const lines = text.split(/\r?\n/)
  const blocks: { title: string; lines: string[] }[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of lines) {
    if (DECLARATION.test(line)) {
      if (current && current.lines.some((item) => item.trim())) blocks.push(current)
      current = { title: line.trim().slice(0, 80), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    } else if (line.trim()) {
      current = { title: "", lines: [line] }
    }
  }
  if (current && current.lines.some((item) => item.trim())) blocks.push(current)
  if (!blocks.length && text.trim()) blocks.push({ title: "", lines: [text] })
  const pieces: { title: string; text: string }[] = []
  for (const block of blocks) {
    for (const part of windowText(block.lines.join("\n").trim())) pieces.push({ title: block.title, text: part })
  }
  return pieces.filter((piece) => piece.text.trim())
}

function windowText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end)
      if (newline > start + CHUNK_CHARS / 2) end = newline
    }
    const part = text.slice(start, end).trim()
    if (part) parts.push(part)
    if (end >= text.length) break
    const next = end - CHUNK_OVERLAP
    start = next > start ? next : end
  }
  return parts
}

function looksLikeHtml(name: string, text: string): boolean {
  return /\.html?$/i.test(name) || /<(?:html|body|p|div|nav|footer)\b/i.test(text)
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
