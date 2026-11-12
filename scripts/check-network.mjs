// The network and key boundary, checked on the syntax tree (the TypeScript compiler API). Outside the transport
// boundary (src/providers/<provider>/http.ts) no file in src/ may reach the network, run code from a string, or read
// the key. It is an ALLOW-LIST for modules and a deny-list only for the few escapes an allow-list cannot express:
//
// Modules. A module specifier (static import, export-from, `import x = require`, `require`, dynamic `import()`, an
// import type) must be a string literal naming a relative path, one of BUILTINS (written with `node:`), or one of
// PACKAGES. Anything else is refused: `bun`, `node:vm`, `node:process`, `_http_client`, an unprefixed builtin, a
// template with substitutions or any other non-literal specifier.
//
// Refused outright:
// - `eval` and `Function` (any reference, `new Function`, `Function("return this")`), and `.constructor` reads (the
//   `x.constructor.constructor` route to Function);
// - `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `Bun`, `Reflect` and `getBuiltinModule`, as any identifier,
//   and the loader escapes `binding`, `_linkedBinding`, `dlopen` as members; their names as strings;
// - `globalThis`, `window`, `self` and `global` other than as a plain, non-computed read of a name in GLOBAL_READS;
// - `process` other than as a non-computed member (`process.env`, `process.pid`): no alias, no destructuring;
// - `require` other than a call with a literal specifier; any `.require` member (`module.require`,
//   `import.meta.require`);
// - an element access with a key that is not a string or number literal, on anything whose name chain includes
//   `integration`, `connection`, `process`, `globalThis`, `window`, `self`, `global` or `Reflect`, or a local alias of
//   one (`const i = ctx.integration` makes `i` sensitive);
// - the host's connection API other than as a direct method call `….connection.<method>(…)` with a method other than
//   `resolve` (no alias, no destructuring, no computed access), and `resolve` read from anything whose name chain
//   includes `connection`.
//
// Known false positives, and how to satisfy the rule:
// - any `x.connection` used as a value, even an unrelated field (status's `view.connection`): read its members
//   directly (`view.connection.state`) instead of keeping the object;
// - the string "resolve" (or "fetch", "Bun"…) anywhere outside a type: name the thing differently;
// - `Reflect.*` and `eval`/`Function` anywhere, even harmless: use the plain operation (`obj[key]` on an ordinary
//   object, `Object.keys`);
// - `return self` or a variable named `global`, `window` or `self`: rename it;
// - a builtin or package not listed: add it to BUILTINS or PACKAGES in this file, in its own reviewed change.
//
// It is a guard against mistakes and quick bypasses, not a proof: review still owns the boundary.
import ts from "typescript"

export const TRANSPORT = /^src\/providers\/[^/]+\/http\.ts$/
/** The Node builtins src/ uses today, outside the transport boundary. */
export const BUILTINS = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:url"])
/** The packages src/ imports: zod (bundled) and what the host provides. package.json has no `dependencies`. */
export const PACKAGES = new Set(["zod", "@opencode/plugin", "@opencode/plugin/promise/tool", "@opencode/plugin/rpc", "@opencode/plugin/tui", "solid-js"])
const DENIED = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Bun", "Reflect", "eval", "Function", "getBuiltinModule"])
const ROOTS = new Set(["globalThis", "window", "self", "global"])
/** What a global root may be read for, as `globalThis.<name>`. */
const GLOBAL_READS = new Set(["structuredClone", "queueMicrotask", "setTimeout", "clearTimeout", "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "URL"])
const LOADERS = new Set(["getBuiltinModule", "binding", "_linkedBinding", "dlopen"])
const STRINGS = new Set(["resolve", ...LOADERS, ...DENIED])
const SENSITIVE = ["integration", "connection", "process", "Reflect", ...ROOTS]

const allowedModule = (specifier) => specifier.startsWith("./") || specifier.startsWith("../") || BUILTINS.has(specifier) || PACKAGES.has(specifier)
const literal = (node) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
const literalKey = (node) => literal(node) || ts.isNumericLiteral(node)
/** The static name of a property or literal element access, or undefined. */
const memberName = (node) =>
  ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && literal(node.argumentExpression) ? node.argumentExpression.text : undefined
const WRAPPERS = (node) =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isAwaitExpression(node)
/** Every identifier and static member name along an access chain: `a.b["c"].d` is a, b, c, d. */
function chain(node) {
  const names = []
  for (let current = node; current; ) {
    if (ts.isIdentifier(current)) {
      names.push(current.text)
      break
    }
    const name = memberName(current)
    if (name !== undefined) names.push(name)
    if (WRAPPERS(current)) current = current.expression
    else break
  }
  return names
}
const inType = (node) => {
  for (let current = node.parent; current; current = current.parent) if (ts.isTypeNode(current) && !ts.isImportTypeNode(current)) return true
  return false
}
/** True when `node` is only the name of a member, a property, a declaration or an import/export binding. */
function nameOnly(node) {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent))
    return parent.name === node
  if (ts.isQualifiedName(parent)) return parent.right === node
  return false
}

/** Problems in one file, as [line, message]. */
export function networkProblems(file, text) {
  if (!file.startsWith("src/") || TRANSPORT.test(file) || !/\.(?:[cm]?[jt]s|tsx)$/.test(file)) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const problems = []
  const report = (node, message) => problems.push([source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message])
  const specifier = (node, argument) => {
    if (!literal(argument)) report(node, "a module specifier that is not a literal")
    else if (!allowedModule(argument.text)) report(node, `a module outside the allow-list: ${argument.text}`)
  }

  // Local aliases of sensitive objects, to a fixed point: `const i = ctx.integration; const j = i` makes both sensitive.
  const sensitive = new Set(SENSITIVE)
  const declarations = []
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(source)
  for (let changed = true; changed; ) {
    changed = false
    for (const declaration of declarations)
      if (!sensitive.has(declaration.name.text) && chain(declaration.initializer).some((name) => sensitive.has(name))) {
        sensitive.add(declaration.name.text)
        changed = true
      }
  }

  const visit = (node) => {
    // Modules: the allow-list.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node, node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier(node, node.moduleReference.expression)
    if (ts.isImportTypeNode(node)) specifier(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) specifier(node, node.arguments[0])
    }

    if (ts.isIdentifier(node)) {
      // A denied name is refused wherever it appears, even as a member or property name: `x.fetch`, `{ Bun }`.
      if (DENIED.has(node.text)) report(node, `refused outside the transport boundary: ${node.text}`)
      if (node.text === "require" && !nameOnly(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, "require used as a value")
      if (ROOTS.has(node.text) && !nameOnly(node)) {
        const read = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && GLOBAL_READS.has(node.parent.name.text)
        const written = read && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left === node.parent && node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        if (!read || written) report(node, `${node.text} used other than as a plain read of an allowed name`)
      }
      if (node.text === "process" && !nameOnly(node)) {
        const member = (ts.isPropertyAccessExpression(node.parent) || (ts.isElementAccessExpression(node.parent) && literalKey(node.parent.argumentExpression))) && node.parent.expression === node
        if (!member) report(node, "process used other than as process.<name>")
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name
      if ((ts.isIdentifier(key) || literal(key)) && key.text === "connection") report(node, "the host connection API destructured")
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "connection") report(node, "the host connection API destructured or aliased")

    const name = memberName(node)
    if (name !== undefined && LOADERS.has(name)) report(node, `module loader access outside the transport boundary: ${name}`)
    if (name === "require") report(node, "a .require member (module.require, import.meta.require)")
    if (name === "constructor") report(node, "a .constructor read (the route to Function)")
    if (name === "connection" && !inType(node)) {
      const parent = node.parent
      const called = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text !== "resolve"
      if (!called) report(node, "the host connection API used other than as …connection.<method>(…)")
    }
    if (name === "resolve" && chain(node.expression).includes("connection")) report(node, "the OpenRouter key is resolved only at the transport boundary")
    if (ts.isElementAccessExpression(node) && !literalKey(node.argumentExpression) && chain(node.expression).some((part) => sensitive.has(part)))
      report(node, "a computed key on the host integration, connection, process, a global or Reflect")
    if (literal(node) && STRINGS.has(node.text) && !inType(node) && !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))
      report(node, `a string naming a network, loader or key API: ${node.text}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return problems
}
