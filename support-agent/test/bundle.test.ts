import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildBundle, type BundleFile } from "../src/bundle.ts"
import { indexBundle, loadCachedBundle, retrieve } from "../src/retrieve.ts"

const fixture = new URL("./fixtures/otherdocs/", import.meta.url).pathname

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "support-docs-"))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
  }
  return dir
}

describe("bundle", () => {
  it("keeps a stable version that changes when a source byte changes", async () => {
    const dir = dirWith({ "guide.md": "# Guide\n\nPublic setup steps.\n" })
    const first = await buildBundle({ docsDirs: [dir], now: () => new Date("2026-01-01T00:00:00Z") })
    const second = await buildBundle({ docsDirs: [dir], now: () => new Date("2026-01-02T00:00:00Z") })
    expect(first.bundle?.version).toMatch(/^[0-9a-f]{12}$/)
    expect(second.bundle?.version).toBe(first.bundle?.version)
    writeFileSync(join(dir, "guide.md"), "# Guide\n\nPublic setup steps changed.\n")
    const third = await buildBundle({ docsDirs: [dir] })
    expect(third.bundle?.version).not.toBe(first.bundle?.version)
    expect(first.bundle?.chunks[0].source).toBe("guide.md")
    expect(JSON.stringify(first.bundle)).not.toContain(dir)
  })

  it("rejects a leaked chunk in strict mode and drops it otherwise", async () => {
    const bodies = [
      "postgres" + "://db.example/app",
      "token ibi_" + "abcdefghijklmnop",
      "see https://example.com" + "/" + "internal" + "/" + "admin",
      "mail stranger@" + "example.com",
    ]
    for (const body of bodies) {
      const dir = dirWith({
        "good.md": "# Guide\n\nThe public handbook explains setup.\n",
        "bad.md": `# Secret\n\n${body}\n`,
      })
      const strict = await buildBundle({ docsDirs: [dir], strict: true, allowedEmails: ["info@p2a.sh"] })
      expect(strict.rejected).toBe(true)
      expect(strict.paused).toBe(true)
      expect(strict.alert).toBe(true)
      expect(strict.bundle).toBeNull()
      const loose = await buildBundle({ docsDirs: [dir], strict: false, allowedEmails: ["info@p2a.sh"] })
      const text = JSON.stringify(loose.bundle)
      expect(text).not.toContain(body)
      expect(text).toContain("public handbook")
      expect(loose.warnings.map((item) => item.file)).toContain("bad.md")
      expect(loose.warnings.some((item) => item.file.includes(body))).toBe(false)
    }
    const previous: BundleFile = {
      version: "bbbbbbbbbbbb",
      builderVersion: "1",
      builtAt: "2026-01-01T00:00:00Z",
      sources: [],
      chunks: [{
        id: "kept",
        source: "old.md",
        url: "old.md",
        title: "",
        text: "safe previous",
        kind: "doc",
      }],
    }
    const again = dirWith({ "bad.md": "# Secret\n\n" + "postgres" + "://db.example/app\n" })
    const keptPrevious = await buildBundle({
      docsDirs: [again],
      strict: true,
      previous,
      allowedEmails: ["info@p2a.sh"],
    })
    expect(keptPrevious.rejected).toBe(true)
    expect(keptPrevious.paused).toBe(false)
    expect(keptPrevious.bundle?.version).toBe("bbbbbbbbbbbb")
    const allowed = dirWith({ "note.md": "# Help\n\nEmail info@p2a.sh for help.\n" })
    const kept = await buildBundle({ docsDirs: [allowed], strict: true, allowedEmails: ["info@p2a.sh"] })
    expect(kept.rejected).toBe(false)
    expect(JSON.stringify(kept.bundle)).toContain("info@p2a.sh")
  })

  it("does not follow a symlink out of the root or a dotfile", async () => {
    const dir = dirWith({ "guide.md": "# Guide\n\nInside the root only.\n" })
    const outside = dirWith({ "outside.md": "OUTSIDE_MARKER should stay out\n" })
    symlinkSync(join(outside, "outside.md"), join(dir, "leak.md"))
    writeFileSync(join(dir, ".secret.md"), "DOTFILE_MARKER stays out\n")
    const built = await buildBundle({ docsDirs: [dir] })
    const text = JSON.stringify(built.bundle)
    expect(text).toContain("Inside the root")
    expect(text).not.toContain("OUTSIDE_MARKER")
    expect(text).not.toContain("DOTFILE_MARKER")
  })

  it("keeps the previous copy when a URL is not fetched", async () => {
    const previous: BundleFile = {
      version: "aaaaaaaaaaaa",
      builderVersion: "1",
      builtAt: "2026-01-01T00:00:00Z",
      sources: [{ source: "https://example.com/guide.txt", sha256: "abc", etag: "v1" }],
      chunks: [{
        id: "1",
        source: "https://example.com/guide.txt",
        url: "https://example.com/guide.txt",
        title: "Guide",
        text: "previous public copy",
        kind: "doc",
      }],
    }
    const fetchImpl = async () => new Response("nope", { status: 500 })
    const built = await buildBundle({
      sourceUrls: ["https://example.com/guide.txt"],
      docsDirs: [],
      previous,
      fetchImpl,
    })
    expect(built.bundle?.chunks.map((chunk) => chunk.text)).toEqual(["previous public copy"])
  })

  it("strips html documents and leaves tags that are part of markdown", async () => {
    const dir = dirWith({
      "note.md": "# Title\n\n<p>keep this tag</p>\n",
      "page.html": "<html><body><p>Hello docs</p></body></html>\n",
    })
    const built = await buildBundle({ docsDirs: [dir] })
    const md = built.bundle?.chunks.find((chunk) => chunk.source === "note.md")?.text ?? ""
    const html = built.bundle?.chunks.find((chunk) => chunk.source === "page.html")?.text ?? ""
    expect(md).toContain("# Title")
    expect(md).toContain("<p>")
    const page = await buildBundle({
      sourceUrls: ["https://example.com/page"],
      docsDirs: [],
      fetchImpl: async () => new Response("<p>Hello page</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    })
    const plain = await buildBundle({
      sourceUrls: ["https://example.com/notes.txt"],
      docsDirs: [],
      fetchImpl: async () => new Response("# Title\n\n<p>keep</p>", { status: 200, headers: { "content-type": "text/plain" } }),
    })
    expect(html).toContain("Hello docs")
    expect(html).not.toContain("<p>")
    expect(page.bundle?.chunks[0]?.text).toContain("Hello page")
    expect(page.bundle?.chunks[0]?.text).not.toContain("<p>")
    expect(plain.bundle?.chunks.map((chunk) => chunk.text).join("\n")).toContain("<p>keep</p>")
  })

  it("drops a secret chunk and keeps the rest of the document", async () => {
    const dir = dirWith({
      "guide.md": `${"Public setup steps. ".repeat(80)}\npostgres` + "://db.example/app\n",
    })
    const loose = await buildBundle({ docsDirs: [dir], strict: false })
    const text = loose.bundle?.chunks.map((chunk) => chunk.text).join("\n") ?? ""
    expect(loose.rejected).toBe(false)
    expect(loose.dropped).toBeGreaterThan(0)
    expect(text).toContain("Public setup")
    expect(text).not.toContain("postgres://")
  })
})

describe("retrieve", () => {
  it("finds a known chunk in another product's docs", async () => {
    const built = await buildBundle({ docsDirs: [fixture], docsBaseUrl: "https://docs.example/" })
    expect(built.bundle).not.toBeNull()
    const bundle = built.bundle!
    const indexed = indexBundle(bundle)
    const hit = retrieve(bundle, indexed, "purple widget warranty", {
      topK: 6,
      contextTokens: 3500,
      minScore: 0,
    })
    expect(hit.offTopic).toBe(false)
    expect(hit.chunks.some((chunk) => chunk.text.includes("purple widget"))).toBe(true)
    expect(hit.chunks[0].url.startsWith("https://docs.example/")).toBe(true)
    const code = retrieve(bundle, indexed, "warranty_months", { topK: 6, contextTokens: 3500, minScore: 0 })
    expect(code.chunks.some((chunk) => chunk.text.includes("warranty_months"))).toBe(true)
    const aside = retrieve(bundle, indexed, "what is 2 + 2", { topK: 6, contextTokens: 3500, minScore: 50 })
    expect(aside.offTopic).toBe(true)
    expect(aside.chunks).toEqual([])
    const product = retrieve(bundle, indexed, "how does p2a work", { topK: 6, contextTokens: 3500, minScore: 50 })
    expect(product.offTopic).toBe(false)
  })

  it("reuses the bundle index until the file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-cache-"))
    const file = {
      version: "v1",
      sources: [{ source: "a.md", sha256: "abc" }],
      chunks: [{ id: "1", source: "a.md", text: "Public setup steps for p2a.", kind: "doc" }],
    }
    writeFileSync(join(dir, "bundle.json"), JSON.stringify(file))
    const first = loadCachedBundle(dir)
    const second = loadCachedBundle(dir)
    expect(second?.index).toBe(first?.index)
    expect(first?.bundle.version).toBe("v1")
    writeFileSync(join(dir, "bundle.json"), JSON.stringify({ ...file, version: "v2-longer" }))
    const third = loadCachedBundle(dir)
    expect(third?.bundle.version).toBe("v2-longer")
    expect(third?.index).not.toBe(first?.index)
    writeFileSync(join(dir, "bundle.json"), "[]")
    expect(loadCachedBundle(dir)?.bundle.chunks).toEqual([])
    expect(loadCachedBundle(dir)?.bundle.version).toBe("none")
  })
})
