import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";
import * as publicApi from "../src/index.js";

const root = fileURLToPath(new URL("../src/", import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  }).sort();
}
const sources = sourceFiles(root).map((path) => {
  const text = readFileSync(path, "utf8");
  return { path, text, ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) };
});
function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}
function dependencies(ast: ts.SourceFile): string[] {
  const imports: string[] = [];
  walk(ast, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) imports.push(argument.text);
    }
  });
  return imports;
}
function within(path: string, directory: string): boolean { return path.startsWith(`${join(root, directory)}/`); }
function targets(path: string, specifier: string, directory: string): boolean {
  return specifier.startsWith(".") && within(resolve(dirname(path), specifier), directory);
}
function environment(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return environment(node.expression);
  if (ts.isIdentifier(node)) return node.text === "env";
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "env";
  if (ts.isElementAccessExpression(node)) return node.argumentExpression !== undefined && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "env";
  return false;
}

test("source contains no credential access, mutating Codex method or deferred v2 strings", () => {
  const forbidden = [".credentials.json", "auth.json", "api/oauth/usage", "refresh_token", "accessToken", "rateLimitResetCredit/consume", "includeRaw", "--watch"];
  for (const { path, text } of sources) for (const value of forbidden) expect(text, path).not.toContain(value);
});

test("application and library modules do not import or re-export CLI code", () => {
  for (const { path, ast } of sources) {
    if (within(path, "cli")) continue;
    for (const dependency of dependencies(ast)) expect(targets(path, dependency, "cli"), `${path}: ${dependency}`).toBe(false);
  }
});

test("CLI modules consume the public API without importing provider, process or core internals", () => {
  for (const { path, ast } of sources) {
    if (!within(path, "cli")) continue;
    for (const dependency of dependencies(ast)) {
      expect(["providers", "process", "core"].some((directory) => targets(path, dependency, directory)), `${path}: ${dependency}`).toBe(false);
    }
  }
});

test("Codex and Claude providers do not depend on each other", () => {
  for (const { path, ast } of sources) {
    const opposite = within(path, "providers/codex") ? "providers/claude" : within(path, "providers/claude") ? "providers/codex" : null;
    if (opposite === null) continue;
    for (const dependency of dependencies(ast)) expect(targets(path, dependency, opposite), `${path}: ${dependency}`).toBe(false);
  }
});

test("domain modules import neither providers nor core", () => {
  for (const { path, ast } of sources) {
    if (!within(path, "domain")) continue;
    for (const dependency of dependencies(ast)) {
      expect(targets(path, dependency, "providers") || targets(path, dependency, "core"), `${path}: ${dependency}`).toBe(false);
    }
  }
});

test("source never enumerates, spreads or serializes an environment object", () => {
  for (const { path, ast } of sources) walk(ast, (node) => {
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) expect(environment(node.expression), path).toBe(false);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression;
    const object = method.expression;
    const guarded = ts.isIdentifier(object) && ((object.text === "Object" && ["keys", "entries", "values"].includes(method.name.text))
      || (object.text === "JSON" && method.name.text === "stringify"));
    if (guarded) for (const argument of node.arguments) expect(environment(argument), path).toBe(false);
  });
});

test("public runtime exports contain exactly the approved API, with no provider internals", () => {
  expect(Object.keys(publicApi).sort()).toEqual(["SCHEMA_VERSION", "UsageReportSchema", "findLimit", "getClaudeUsage", "getCodexUsage", "getUsage"].sort());
  const index = sources.find((source) => source.path === join(root, "index.ts"));
  expect(index).toBeDefined();
  if (index === undefined) return;
  for (const statement of index.ast.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const dependency = statement.moduleSpecifier.text;
    expect(targets(index.path, dependency, "providers") || targets(index.path, dependency, "process"), dependency).toBe(false);
  }
});

test("application source uses named exports and no explicit any types", () => {
  for (const { path, ast } of sources) walk(ast, (node) => {
    expect(ts.isExportAssignment(node), path).toBe(false);
    expect(node.kind === ts.SyntaxKind.AnyKeyword, path).toBe(false);
    if (ts.canHaveModifiers(node)) expect(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false, path).toBe(false);
  });
});

// SPEC §13.6's frozen Codex allowlist and mutation-before-write assertions are
// already covered by tests/integration/codex-client.test.ts; keep that test
// unchanged rather than duplicating it here.

test("demo data is pure and imports only public API types", () => {
  const demo = sources.find((source) => source.path === join(root, "cli/demo.ts"));
  expect(demo).toBeDefined();
  if (demo === undefined) return;
  for (const forbidden of ["node:", "process.", "Date.now", "Math.random", "spawn", "fetch(", "readFile", "fixtures",
    "getUsage", "getCodexUsage", "getClaudeUsage"]) expect(demo.text).not.toContain(forbidden);
  walk(demo.ast, (node) => {
    if (ts.isImportDeclaration(node)) {
      expect(node.importClause?.isTypeOnly).toBe(true);
      expect(ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text).toBe("../index.js");
    }
    if (ts.isImportEqualsDeclaration(node)) expect(node.isTypeOnly).toBe(true);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) expect(node.isTypeOnly).toBe(true);
    if (ts.isCallExpression(node)) {
      expect(node.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(false);
      expect(ts.isIdentifier(node.expression) && node.expression.text === "require").toBe(false);
    }
  });
});
