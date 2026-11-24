import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) found.push(...files(path))
    else if (name.endsWith(".ts")) found.push(path)
  }
  return found
}

function specifier(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const first = node.arguments[0]
    if (first && ts.isStringLiteral(first)) return first.text
  }
  return null
}

describe("self contained", () => {
  it("imports only builtins, declared packages, and paths inside this folder", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["p2a-sdk"])
    expect(pkg.dependencies["p2a-sdk"]).toBe("^0.1")
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)])
    const lock = readFileSync(join(root, "package-lock.json"), "utf8")
    const forbidden = /(?:file:|link:|workspace:)/
    expect(JSON.stringify(pkg)).not.toMatch(forbidden)
    expect(lock).not.toMatch(forbidden)
    const problems: string[] = []
    for (const file of [...files(join(root, "src")), ...files(join(root, "test")), ...files(join(root, "evals"))]) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (node: ts.Node) => {
        const spec = specifier(node)
        if (spec) check(file, spec, declared, problems)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(problems).toEqual([])
  })
})

function check(file: string, spec: string, declared: Set<string>, problems: string[]) {
  if (spec.startsWith("node:") || builtins.has(spec)) {
    if (!builtins.has(spec) && !builtins.has(spec.replace(/^node:/, ""))) problems.push(`${file} ${spec}`)
    return
  }
  if (spec.startsWith(".")) {
    const target = resolve(dirname(file), spec)
    const rel = relative(root, target)
    if (rel.startsWith("..") || rel.startsWith("/")) problems.push(`${file} ${spec}`)
    return
  }
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
  if (!declared.has(name)) problems.push(`${file} ${spec}`)
}
