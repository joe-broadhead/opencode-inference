// The network and key boundary, checked on the syntax tree and the type checker (the TypeScript compiler API).
//
// What it guarantees: no ACCIDENTAL or CASUAL network or key access outside the transport boundary
// (src/providers/<provider>/http.ts): no network module, network global, string-evaluated code, loader escape,
// prototype route or computed key that could name one, and no reach into the host's connection API other than a
// plain method call. What it does not: a static check cannot be complete for JavaScript. Deliberate obfuscation, such as
// passing the integration object through function arguments, iterating it with `Object.entries`, or hiding a name in
// data, can still get through. Code review and the runtime network spy (test/support/network-spy.ts, which refuses
// every network path in the unit tests) are the backstop; the bundle check in check-forbidden.mjs keeps dist/ to src/
// and the inlined packages.
//
// Modules are an ALLOW-LIST. A module specifier (static import, export-from, `import x = require`, `require`, dynamic
// `import()`, an import type) must be a string literal naming a relative path that stays inside src/, one of BUILTINS
// (written with `node:`), or one of PACKAGES. Anything else is refused: `bun`, `node:vm`, `node:process`,
// `_http_client`, an unprefixed builtin, `../../scripts/…`, `../../node_modules/…`, a non-literal specifier.
//
// Refused outright:
// - `eval` and `Function` (any reference, `new Function`, `Function("return this")`);
// - `.constructor`, `.prototype` and `.__proto__`, and those names as strings; `Object.getOwnPropertyDescriptor(s)`,
//   `defineProperty`/`defineProperties`, `setPrototypeOf` (the shared tools-RPC copy may use defineProperty); so no
//   assignment to a built-in prototype either;
// - `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `Bun`, `Reflect` and `getBuiltinModule`, as any identifier,
//   and the loader escapes `binding`, `_linkedBinding`, `dlopen` as members; their names as strings;
// - `globalThis`, `window`, `self` and `global` other than as a plain, non-computed read of a name in GLOBAL_READS;
// - `process` other than `process.env`, `process.pid`, `process.platform`, `process.cwd` and `process.kill` (the
//   journal lock's liveness probe): no alias, no destructuring, no other member (`execve`, `binding`, `dlopen`);
// - `require` other than a call with a literal specifier; any `.require` member (`module.require`, `import.meta.require`);
// - a computed key that is not a string or number literal, unless the type checker says every value it can take is a
//   number or a string literal outside the refused names (arrays by index and records by a literal-union key work;
//   `record[someString]` does not: use a Map); computed destructuring keys; computed access on `import.meta`;
// - the host's connection API other than as a direct method call `….connection.<method>(…)` with a method other than
//   `resolve` (no alias, no destructuring, no computed access), and `resolve` read from anything whose name chain
//   includes `connection`.
//
// Known false positives, and how to satisfy the rule:
// - any `x.connection` used as a value, even an unrelated field (status's `view.connection`): read its members
//   directly (`view.connection.state`) instead of keeping the object;
// - the strings "resolve", "constructor", "prototype" (or "fetch", "Bun"…) anywhere outside a type: name things
//   differently;
// - `Reflect.*`, `eval`, `Function` and `Object.defineProperty` anywhere, even harmless: use the plain operation;
// - a lookup by a wide `string` key: use a Map (`new Map(Object.entries(record)).get(key)`);
// - `return self` or a variable named `global`, `window` or `self`: rename it;
// - a builtin or package not listed: add it to BUILTINS or PACKAGES in this file, in its own reviewed change.
import { dirname, isAbsolute, join, posix } from "node:path"
import ts from "typescript"

export const TRANSPORT = /^src\/providers\/[^/]+\/http\.ts$/
/** The family's shared tools-RPC module: its own checksum guards it; only Object.defineProperty is allowed there. */
const SHARED_COPY = "src/host/tools-rpc.ts"
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
/** The only members of `process` src/ may touch. `kill` is the journal lock's liveness probe (signal 0). */
const PROCESS_MEMBERS = new Set(["env", "pid", "platform", "cwd", "kill"])
/** Names that reach a prototype or a property definition. Refused as strings, members and computed key values. */
const PROTOTYPE = new Set(["constructor", "prototype", "__proto__"])
const DEFINERS = new Set(["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties", "setPrototypeOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__"])
/** A computed key whose type admits one of these values is refused. */
const KEY_VALUES = new Set([...PROTOTYPE, ...STRINGS, ...DEFINERS, "connection", "require"])

/** A relative specifier must resolve inside src/; anything else must be a listed builtin or package. */
const allowedModule = (file, specifier) =>
  specifier.startsWith("./") || specifier.startsWith("../") ? posix.normalize(posix.join(posix.dirname(file), specifier)).startsWith("src/") : BUILTINS.has(specifier) || PACKAGES.has(specifier)
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

const checked = (file) => file.startsWith("src/") && !TRANSPORT.test(file) && /\.(?:[cm]?[jt]s|tsx)$/.test(file)

/** Library and package declaration files, parsed once per process and shared by every program. */
const declarations = new Map()

/**
 * Type-checks `files` (repository-relative path -> text) as one program rooted at `root`, with the repository's
 * compiler options, so a computed key can be judged by its type. Returns the problems per file, as [line, message].
 */
export function networkProblemsAll(root, files) {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile)
  const options = { ...ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root).options, noEmit: true }
  const texts = new Map(Object.entries(files).filter(([file]) => checked(file)).map(([file, text]) => [join(root, file), text]))
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, language, onError) => {
    if (texts.has(name)) return ts.createSourceFile(name, texts.get(name), language, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    if (!declarations.has(name)) declarations.set(name, getSourceFile(name, language, onError))
    return declarations.get(name)
  }
  const exists = host.fileExists.bind(host)
  host.fileExists = (name) => texts.has(name) || exists(name)
  const read = host.readFile.bind(host)
  host.readFile = (name) => texts.get(name) ?? read(name)
  const program = ts.createProgram([...texts.keys()], options, host)
  const checker = program.getTypeChecker()
  const result = {}
  for (const [path] of texts) {
    const file = posix.normalize(path.slice(root.length).replace(/^[\\/]+/, "").split("\\").join("/"))
    result[file] = problemsOf(file, program.getSourceFile(path), checker)
  }
  return result
}

/** Problems in one file, as [line, message]. Type-checks it alone, against the repository's options and packages. */
export function networkProblems(file, text, root = join(dirname(new URL(import.meta.url).pathname), "..")) {
  if (!checked(file)) return []
  return networkProblemsAll(root, { [file]: text })[file] ?? []
}

/** True when every value a key's type admits is a number, or a string literal outside KEY_VALUES. */
function safeKey(checker, expression) {
  const type = checker.getTypeAtLocation(expression)
  const parts = type.isUnion() ? type.types : [type]
  return parts.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0 || ((part.flags & ts.TypeFlags.StringLiteral) !== 0 && !KEY_VALUES.has(part.value)))
}

function problemsOf(file, source, checker) {
  const problems = []
  const report = (node, message) => problems.push([source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message])
  const specifier = (node, argument) => {
    if (!literal(argument)) report(node, "a module specifier that is not a literal")
    else if (!allowedModule(file, argument.text)) report(node, `a module outside the allow-list: ${argument.text}`)
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
        const name = node.parent.expression === node ? memberName(node.parent) : undefined
        if (name === undefined || !PROCESS_MEMBERS.has(name)) report(node, `process used other than as process.${[...PROCESS_MEMBERS].join("|")}`)
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
    if (name !== undefined && PROTOTYPE.has(name)) report(node, `a .${name} access (the route to Function and to shared prototypes)`)
    // The shared tools-RPC copy (checked byte for byte by check-copies.mjs) defines one non-enumerable schema field.
    if (name !== undefined && DEFINERS.has(name) && file !== SHARED_COPY) report(node, `a property-definition escape: ${name}`)
    if (ts.isElementAccessExpression(node) && !literalKey(node.argumentExpression) && !safeKey(checker, node.argumentExpression))
      report(node, "a computed key whose type is not a number or a known safe string literal")
    if (ts.isElementAccessExpression(node) && ts.isMetaProperty(node.expression)) report(node, "a computed access on import.meta")
    if (ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName)) report(node, "a computed destructuring key")
    if (name === "connection" && !inType(node)) {
      const parent = node.parent
      const called = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text !== "resolve"
      if (!called) report(node, "the host connection API used other than as …connection.<method>(…)")
    }
    if (name === "resolve" && chain(node.expression).includes("connection")) report(node, "the OpenRouter key is resolved only at the transport boundary")
    if (ts.isElementAccessExpression(node) && !literalKey(node.argumentExpression) && chain(node.expression).some((part) => sensitive.has(part)))
      report(node, "a computed key on the host integration, connection, process, a global or Reflect")
    if (literal(node) && (STRINGS.has(node.text) || PROTOTYPE.has(node.text)) && !inType(node) && !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))
      report(node, `a string naming a network, loader or key API: ${node.text}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return problems
}
