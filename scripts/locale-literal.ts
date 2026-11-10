/** Static literal expansion for locale key and template checks; package code is never executed. */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'

interface Module {
  readonly source: ts.SourceFile
  readonly constants: ReadonlyMap<string, { expression: ts.Expression; exported: boolean }>
  readonly imports: ReadonlyMap<string, { file: string; name: string }>
}

interface Value {
  readonly expression: ts.Expression
  readonly module: Module
  readonly shared: boolean
}

/** Expanded keys and statically available string templates. */
export interface LocaleLiteral {
  readonly keys: string[]
  readonly templates: Readonly<Record<string, string>>
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

/**
 * Inspect a literal with fixed const-object spreads from this module or relative named imports.
 * @param repositoryRoot - source containment boundary.
 * @param source - current parsed source module.
 * @returns reader preserving object spread order and rejecting unresolved or cyclic shared values.
 */
export function localeLiteralReader(repositoryRoot: string, source: ts.SourceFile): (literal: ts.ObjectLiteralExpression) => LocaleLiteral {
  const root = realpathSync(repositoryRoot)
  const modules = new Map<string, Module>()
  const canonical = (file: string): string => {
    const path = realpathSync(file)
    const location = relative(root, path)
    if (location === '..' || location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(location)) {
      throw new Error(`locale literal source escapes repository: ${file}`)
    }
    return path
  }
  const fail = (module: Module, node: ts.Node, key: string, reason: string): never => {
    const at = module.source.getLineAndCharacterOfPosition(node.getStart(module.source))
    throw new Error(`${relative(root, module.source.fileName)}:${at.line + 1}:${at.character + 1} locale ${key}: ${reason}`)
  }
  const load = (file: string, parsed?: ts.SourceFile): Module => {
    const path = canonical(file)
    const cached = modules.get(path)
    if (cached !== undefined) return cached
    const current = parsed ?? ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true)
    const constants = new Map<string, { expression: ts.Expression; exported: boolean }>()
    const imports = new Map<string, { file: string; name: string }>()
    for (const statement of current.statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            constants.set(declaration.name.text, { expression: declaration.initializer,
              exported: statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true })
          }
        }
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.importClause?.phaseModifier === undefined && statement.importClause?.namedBindings !== undefined
        && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const binding of statement.importClause.namedBindings.elements) {
          if (!binding.isTypeOnly) imports.set(binding.name.text, { file: statement.moduleSpecifier.text,
            name: binding.propertyName?.text ?? binding.name.text })
        }
      }
    }
    const result = { source: current, constants, imports }
    modules.set(path, result)
    return result
  }
  const initial = load(source.fileName, source)
  function bound(module: Module, name: string, node: ts.Node, key: string, required: true): Value
  function bound(module: Module, name: string, node: ts.Node, key: string, required: boolean): Value | undefined
  function bound(module: Module, name: string, node: ts.Node, key: string, required: boolean): Value | undefined {
    const local = module.constants.get(name)
    if (local !== undefined) return { expression: local.expression, module, shared: false }
    const imported = module.imports.get(name)
    if (imported !== undefined && (imported.file.startsWith('./') || imported.file.startsWith('../'))) {
      const other = load(resolve(dirname(module.source.fileName), imported.file))
      const declaration = other.constants.get(imported.name)
      if (declaration?.exported !== true) return fail(module, node, key, `import ${name} is not an exported const literal`)
      return { expression: declaration.expression, module: other, shared: false }
    }
    if (required) return fail(module, node, key, `cannot resolve static const ${name}`)
    return undefined
  }
  const enter = <T>(value: Value, key: string, active: Set<string>, read: (next: Set<string>) => T): T => {
    const id = `${value.module.source.fileName}:${value.expression.pos}`
    if (active.has(id)) return fail(value.module, value.expression, key, 'cyclic literal reference')
    return read(new Set([...active, id]))
  }
  const properties = (value: Value, active: Set<string>, label: string): Map<string, Value> => enter(value, label, active, (next) => {
    const expression = unwrap(value.expression)
    if (ts.isIdentifier(expression)) {
      const target = bound(value.module, expression.text, expression, label, true)
      return properties(target, next, label)
    }
    if (!ts.isObjectLiteralExpression(expression)) return fail(value.module, expression, label, 'spread must resolve to a static const object literal')
    const values = new Map<string, Value>()
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const shared = { expression: property.expression, module: value.module, shared: true }
        for (const [key, entry] of properties(shared, next, property.expression.getText(value.module.source))) {
          values.set(key, { ...entry, shared: true })
        }
      } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
        values.set(property.name.text, { expression: property.initializer, module: value.module, shared: value.shared })
      } else {
        return fail(value.module, property, label, 'dictionary properties must have fixed literal keys')
      }
    }
    return values
  })
  const template = (value: Value, active: Set<string>, key: string): string | undefined => enter(value, key, active, (next) => {
    const expression = unwrap(value.expression)
    if (ts.isStringLiteralLike(expression)) return expression.text
    const separator = ts.isCallExpression(expression) ? expression.arguments[0] : undefined
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === 'join' && ts.isArrayLiteralExpression(expression.expression.expression)
      && expression.arguments.length === 1 && separator !== undefined && ts.isStringLiteralLike(separator)) {
      const parts: string[] = []
      for (const part of expression.expression.expression.elements) {
        if (!ts.isStringLiteralLike(part)) {
          if (value.shared) return fail(value.module, part, key, 'shared joined templates require literal strings')
          return undefined
        }
        parts.push(part.text)
      }
      return parts.join(separator.text)
    }
    if (ts.isIdentifier(expression)) {
      const target = bound(value.module, expression.text, expression, key, value.shared)
      return target === undefined ? undefined : template({ ...target, shared: value.shared }, next, key)
    }
    const member = ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined
    const owner = ts.isElementAccessExpression(expression) || ts.isPropertyAccessExpression(expression) ? expression.expression : undefined
    if (member !== undefined && owner !== undefined && ts.isIdentifier(owner) && owner.text === 'en') {
      const target = bound(value.module, 'en', owner, key, true)
      const entry = properties(target, next, key).get(member)
      if (entry === undefined) return fail(value.module, expression, key, `English member ${member} is absent`)
      return template({ ...entry, shared: value.shared }, next, key)
    }
    // Existing direct computed copy has its own token owner; shared literals must be fully inspectable.
    if (value.shared) return fail(value.module, expression, key, 'shared template is not a fixed string or English member')
    return undefined
  })
  return (literal) => {
    const entries = properties({ expression: literal, module: initial, shared: false }, new Set(), 'dictionary')
    const templates: Record<string, string> = {}
    for (const [key, value] of entries) {
      const text = template(value, new Set(), key)
      if (text !== undefined) templates[key] = text
    }
    return { keys: [...entries.keys()].sort(), templates }
  }
}
