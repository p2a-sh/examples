export const LOG_FIELDS = [
  "ts",
  "level",
  "event",
  "error_code",
  "status",
  "count",
  "category",
  "duration_ms",
  "skipped",
  "file",
  "clarified",
  "kind",
] as const

const FIELDS = new Set<string>(LOG_FIELDS)

export type LogLevel = "debug" | "info" | "warn" | "error"

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function logLine(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  minimum: LogLevel = "info",
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): void {
  if (RANK[level] < RANK[minimum]) return
  const record: Record<string, unknown> = { ts: new Date().toISOString(), level, event }
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key) || key === "ts" || key === "level" || key === "event") continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      record[key] = value
    }
  }
  write(JSON.stringify(record))
}
