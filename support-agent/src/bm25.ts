export const K1 = 1.2
export const B = 0.75

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
  "while", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "as", "is", "are", "was", "were", "be", "been", "being", "it", "this",
  "that", "these", "those", "i", "you", "we", "they", "he", "she", "them",
  "my", "your", "our", "their", "not", "no", "yes", "do", "does", "did",
  "can", "could", "should", "would", "will", "just", "about", "into", "over",
  "under", "than",
])

const TOKEN = /[a-z0-9]+(?:[-_][a-z0-9]+)*@[a-z0-9]+(?:[-_][a-z0-9]+)*|[a-z_][a-z0-9_-]*/g

export interface Bm25Doc {
  id: string
  tf: Map<string, number>
  len: number
}

export interface Bm25Index {
  docs: Bm25Doc[]
  df: Map<string, number>
  avgdl: number
}

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(TOKEN) ?? []
  const folded: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const current = raw[i]
    const next = raw[i + 1]
    if (current === "chat" && next === "gpt") {
      folded.push("chatgpt")
      i += 1
      continue
    }
    if (current === "api" && next === "key") {
      folded.push("token")
      i += 1
      continue
    }
    if (STOPWORDS.has(current)) continue
    folded.push(current)
    // Index the parts of tool names like p2a_check_new so "check ... new" finds them.
    if (!current.includes("@") && /[-_]/.test(current)) {
      for (const part of current.split(/[-_]+/)) {
        if (part.length > 1 && !STOPWORDS.has(part)) folded.push(part)
      }
    }
  }
  return folded
}

export function buildIndex(docs: { id: string; text: string }[]): Bm25Index {
  const built: Bm25Doc[] = []
  const df = new Map<string, number>()
  let total = 0
  for (const doc of docs) {
    const tf = new Map<string, number>()
    for (const token of tokenize(doc.text)) tf.set(token, (tf.get(token) ?? 0) + 1)
    built.push({ id: doc.id, tf, len: tf.size === 0 ? 0 : [...tf.values()].reduce((sum, n) => sum + n, 0) })
    total += built[built.length - 1].len
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return { docs: built, df, avgdl: built.length ? total / built.length : 0 }
}

export function search(index: Bm25Index, query: string, limit: number): { id: string; score: number }[] {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !index.docs.length) return []
  const n = index.docs.length
  const scored = index.docs.map((doc) => {
    let score = 0
    for (const term of terms) {
      const freq = doc.tf.get(term) ?? 0
      if (!freq) continue
      const df = index.df.get(term) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      const norm = freq * (K1 + 1)
      const denom = freq + K1 * (1 - B + B * (doc.len / (index.avgdl || 1)))
      score += idf * (norm / denom)
    }
    return { id: doc.id, score }
  })
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}
