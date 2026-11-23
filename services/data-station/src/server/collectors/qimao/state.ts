/** Literal-only parsing of one official serialized Nuxt assignment; source expressions are never executed. */
import { parse as parseJavaScript, type AnyNode } from 'acorn';

const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Reads the single returned value from the supported Nuxt serialization wrapper.
 * @param script One complete window.__NUXT__ assignment from a script element.
 * @param options Enables only the book page's bounded empty-object/array aliases and literal own-property initialization.
 * @returns Literal JSON-compatible values after rejecting executable expressions and unsafe object properties.
 */
export function parseQimaoState(script: string, options: { allowCollectionAliases?: boolean } = {}): unknown {
  if (script.length > 2_097_152) throw new Error('Catalog state exceeds parser limit');
  const program = parseJavaScript(script, { ecmaVersion: 2022 });
  if (program.body.length !== 1 || program.body[0]!.type !== 'ExpressionStatement') throw new Error('Unsupported catalog state statement');
  const assignment = program.body[0]!.expression;
  if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' || assignment.left.type !== 'MemberExpression'
    || assignment.left.computed || assignment.left.object.type !== 'Identifier' || assignment.left.object.name !== 'window'
    || assignment.left.property.type !== 'Identifier' || assignment.left.property.name !== '__NUXT__') throw new Error('Unsupported catalog state assignment');
  const call = assignment.right;
  if (call.type !== 'CallExpression' || call.callee.type !== 'FunctionExpression' || call.callee.async || call.callee.generator
    || !call.callee.body.body.length || !options.allowCollectionAliases && call.callee.body.body.length !== 1
    || call.callee.body.body.at(-1)!.type !== 'ReturnStatement'
    || call.arguments.length !== call.callee.params.length || call.arguments.length > 512) throw new Error('Unsupported catalog state wrapper');
  let visited = 0;
  const aliases = new Map<string, unknown>();
  const read = (node: AnyNode, depth = 0): unknown => {
    if (++visited > 100_000 || depth > 40) throw new Error('Catalog state exceeds AST limits');
    if (node.type === 'Literal') {
      if (node.value === null || typeof node.value === 'string' || typeof node.value === 'boolean'
        || typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
    } else if (node.type === 'Identifier' && aliases.has(node.name)) return aliases.get(node.name);
    else if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal'
      && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) return -node.argument.value;
    else if (node.type === 'ArrayExpression') return node.elements.map(item => {
      if (!item) throw new Error('Sparse catalog state array');
      return read(item, depth + 1);
    });
    else if (node.type === 'ObjectExpression') {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') throw new Error('Unsupported catalog property');
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : null;
        if (key === null || blockedKeys.has(key) || Object.hasOwn(result, key)) throw new Error('Unsafe or repeated catalog property');
        result[key] = read(property.value, depth + 1);
      }
      return result;
    }
    throw new Error('Catalog state contains an executable or unsupported expression');
  };
  for (const [index, parameter] of call.callee.params.entries()) {
    const argument = call.arguments[index]!;
    if (parameter.type !== 'Identifier' || aliases.has(parameter.name) || blockedKeys.has(parameter.name)
      || options.allowCollectionAliases && parameter.name === 'Array') throw new Error('Unsupported catalog state alias');
    let value: unknown;
    if (options.allowCollectionAliases && argument.type === 'ObjectExpression' && argument.properties.length === 0) value = Object.create(null);
    else if (options.allowCollectionAliases && argument.type === 'CallExpression' && argument.callee.type === 'Identifier'
      && argument.callee.name === 'Array' && argument.arguments.length === 1 && argument.arguments[0]!.type === 'Literal'
      && typeof argument.arguments[0]!.value === 'number' && Number.isInteger(argument.arguments[0]!.value)
      && argument.arguments[0]!.value >= 0 && argument.arguments[0]!.value <= 20_000) value = new Array(argument.arguments[0]!.value);
    else {
      if (argument.type !== 'Literal' && argument.type !== 'UnaryExpression') throw new Error('Unsupported catalog state alias');
      value = read(argument);
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Nonprimitive catalog state alias');
    }
    aliases.set(parameter.name, value);
  }
  for (const statement of call.callee.body.body.slice(0, -1)) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression' || statement.expression.operator !== '=') throw new Error('Unsupported catalog state initializer');
    const assignment = statement.expression;
    if (assignment.left.type !== 'MemberExpression' || assignment.left.object.type !== 'Identifier') throw new Error('Unsupported catalog state assignment target');
    const target = aliases.get(assignment.left.object.name);
    if (Array.isArray(target)) {
      const property = assignment.left.property;
      if (!assignment.left.computed || property.type !== 'Literal' || typeof property.value !== 'number' || !Number.isInteger(property.value)
        || property.value < 0 || property.value >= target.length || Object.hasOwn(target, property.value)) throw new Error('Invalid catalog array initialization');
      target[property.value] = read(assignment.right);
    } else {
      if (typeof target !== 'object' || target === null || assignment.left.computed || assignment.left.property.type !== 'Identifier'
        || blockedKeys.has(assignment.left.property.name) || Object.hasOwn(target, assignment.left.property.name)) throw new Error('Invalid catalog object initialization');
      Object.defineProperty(target, assignment.left.property.name, { value: read(assignment.right), enumerable: true });
    }
  }
  const final = call.callee.body.body.at(-1)!;
  if (final.type !== 'ReturnStatement') throw new Error('Catalog state has no return');
  const returned = final.argument;
  if (!returned) throw new Error('Catalog state has no returned value');
  const result = read(returned);
  if (options.allowCollectionAliases) {
    const active = new Set<object>(), checked = new Map<object, number>(); let objects = 0;
    const verify = (value: unknown, depth = 0): number => {
      if (value === undefined) throw new Error('Uninitialized catalog state value');
      if (typeof value !== 'object' || value === null) return typeof value === 'string' ? value.length + 2 : 16;
      if (active.has(value) || depth > 40) throw new Error('Cyclic or oversized catalog state aliases');
      const existing = checked.get(value); if (existing !== undefined) return existing;
      if (++objects > 100_000) throw new Error('Oversized catalog state aliases');
      active.add(value);
      let size = 2;
      const add = (weight: number) => { size += weight; if (size > 16_777_216) throw new Error('Catalog alias expansion exceeds parser limit'); };
      if (Array.isArray(value)) for (let index = 0; index < value.length; index++) add(verify(value[index], depth + 1));
      else for (const [key, field] of Object.entries(value)) add(key.length + verify(field, depth + 1));
      active.delete(value); checked.set(value, size); return size;
    };
    verify(result);
  }
  return result;
}
