function marker(parts: string[]): RegExp {
  return new RegExp(parts.join(""))
}

// Markers are joined so the source does not contain a live secret or an internal URL.
const SECRET_PATTERNS: RegExp[] = [
  marker(["ibi_", "[A-Za-z0-9]{8,}"]),
  marker(["sk-", "[A-Za-z0-9]{16,}"]),
  marker(["wh", "sec_", "[A-Za-z0-9+/=]{16,}"]),
  marker(["-----", "BEGIN [A-Z ]*PRIVATE KEY-----"]),
  marker(["AKIA", "[0-9A-Z]{16}"]),
  marker(["gh", "p_", "[A-Za-z0-9]{20,}"]),
  marker(["xox", "[bap]-", "[A-Za-z0-9-]{10,}"]),
  marker(["postgres(?:ql)?:", "\\/\\/"]),
  marker(["redis:", "\\/\\/"]),
  marker(["/", "internal", "/"]),
  marker(["aweb", ":8000"]),
  marker(["\\b", "10", "\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"]),
  marker(["\\b", "192", ".168", "\\.\\d{1,3}\\.\\d{1,3}\\b"]),
  marker(["\\b", "172", "\\.(?:1[6-9]|2\\d|3[0-1])\\.\\d{1,3}\\.\\d{1,3}\\b"]),
]

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "g"), "[redacted]")
  }
  return out
}

export function leakKind(text: string, allowedEmails: readonly string[]): "secret" | "email" | null {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return "secret"
  }
  const allowed = new Set(allowedEmails.map((item) => item.toLowerCase()))
  EMAIL.lastIndex = 0
  const found = text.match(EMAIL) ?? []
  for (const email of found) {
    if (!allowed.has(email.toLowerCase())) return "email"
  }
  return null
}
