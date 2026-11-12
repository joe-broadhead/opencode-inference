// The network boundary, checked on the syntax tree (the TypeScript compiler API), not on text: outside the transport
// boundary (src/providers/<provider>/http.ts) no file in src/ may reach the network or read the key. Refused:
//
// - importing, requiring or dynamically importing a network or process module, with or without `node:` and with any
//   subpath, as a string or a template literal; a module specifier that is not a literal at all; `import.meta.require`
//   and `require` used as a value;
// - `process.getBuiltinModule` and the other loader escapes (`binding`, `_linkedBinding`, `dlopen`), by name or as a
//   string key;
// - any reference to `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `Bun` or `Reflect`;
// - `globalThis`, `window` or `self` used other than as `<global>.<static name>`: computed access and aliasing;
// - the host's connection API used other than as a direct method call `….connection.<method>(…)` with a method other
//   than `resolve`: no alias, no destructuring, no computed access; and `resolve` read from anything whose name chain
//   contains `connection`, or named by a string.
//
// It is a guard against mistakes and quick bypasses, not a proof: review still owns the boundary.
import ts from "typescript"

export const TRANSPORT = /^src\/providers\/[^/]+\/http\.ts$/
const MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "undici", "child_process", "worker_threads", "module", "cluster", "inspector"])
const GLOBALS = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Bun", "Reflect"])
const ROOTS = new Set(["globalThis", "window", "self"])
const LOADERS = new Set(["getBuiltinModule", "binding", "_linkedBinding", "dlopen"])
const STRINGS = new Set(["resolve", ...LOADERS, ...GLOBALS])

const forbiddenModule = (specifier) => MODULES.has(specifier.replace(/^node:/, "").split("/")[0])
const literal = (node) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
/** The static name of a property or literal element access, or undefined. */
const memberName = (node) =>
  ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && literal(node.argumentExpression) ? node.argumentExpression.text : undefined
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
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression
    else break
  }
  return names
}
const inType = (node) => {
  for (let current = node.parent; current; current = current.parent) if (ts.isTypeNode(current)) return true
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
    else if (forbiddenModule(argument.text)) report(node, `network module import outside the transport boundary: ${argument.text}`)
  }

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node, node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier(node, node.moduleReference.expression)
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const named = chain(callee)[0]
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require") || named === "require") specifier(node, node.arguments[0])
    }
    if (ts.isIdentifier(node)) {
      if (GLOBALS.has(node.text)) report(node, `network access outside the transport boundary: ${node.text}`)
      if (node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, "require used as a value")
      const declared = node.parent && "name" in node.parent && node.parent.name === node && !ts.isPropertyAccessExpression(node.parent)
      if (ROOTS.has(node.text) && !ts.isPropertyAccessExpression(node.parent) && !declared) report(node, `${node.text} used other than as ${node.text}.<name>`)
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ROOTS.has(node.expression.text)) report(node, `computed access on ${node.expression.text}`)
    if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "require") report(node, "import.meta.require")
    const name = memberName(node)
    if (name !== undefined && LOADERS.has(name)) report(node, `module loader access outside the transport boundary: ${name}`)
    if (name === "connection" && !inType(node)) {
      const parent = node.parent
      const called = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text !== "resolve"
      if (!called) report(node, "the host connection API used other than as …connection.<method>(…)")
    }
    if (name === "resolve" && chain(node.expression).includes("connection")) report(node, "the OpenRouter key is resolved only at the transport boundary")
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name
      if ((ts.isIdentifier(key) || literal(key)) && key.text === "connection") report(node, "the host connection API destructured")
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "connection") report(node, "the host connection API destructured or aliased")
    if (literal(node) && STRINGS.has(node.text) && !inType(node) && !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))
      report(node, `a string naming a network or key API: ${node.text}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return problems
}
