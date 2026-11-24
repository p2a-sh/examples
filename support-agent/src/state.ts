import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function readJson<T>(dir: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as T
  } catch {
    return null
  }
}

export function writeJsonAtomic(dir: string, name: string, value: unknown): void {
  writeTextAtomic(dir, name, JSON.stringify(value))
}

export function readText(dir: string, name: string): string | null {
  try {
    return readFileSync(join(dir, name), "utf8")
  } catch {
    return null
  }
}

let tempSerial = 0

export function writeTextAtomic(dir: string, name: string, value: string): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  tempSerial += 1
  const temp = `${path}.${process.pid}.${tempSerial}.tmp`
  writeFileSync(temp, value, "utf8")
  renameSync(temp, path)
}

export function fileExists(dir: string, name: string): boolean {
  try {
    readFileSync(join(dir, name))
    return true
  } catch {
    return false
  }
}
