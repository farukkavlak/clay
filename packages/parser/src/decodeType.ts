import { Type, types } from '@clay/contracts';

import { AttributeValue, CallNode, TypeDefaults } from './ast';
import { checkConstant } from './checkConstant';
import { ConfigError } from './ConfigError';

export interface ParsedType {
  type: Type;
  defaults?: TypeDefaults;
}

interface AttributeType extends ParsedType {
  optional?: true;
  default?: AttributeValue;
}

type Decode = (value: AttributeValue) => ParsedType;

const PRIMITIVE_TYPES = new Map<string, Type>([
  ['string', types.string],
  ['number', types.number],
  ['bool', types.bool],
  ['any', types.dynamic],
]);

const COLLECTIONS: Record<string, (element: Type) => Type> = { list: types.list, set: types.set, map: types.map };

const HOLDING_TYPES = new Set(['tuple', 'object', ...Object.keys(COLLECTIONS)]);

const A_TYPE = 'Expect a type: string, number, bool, any, list(...), set(...), map(...), tuple([...]) or object({...}).';

/** Drops empty records, so a type without defaults has no `defaults`. */
function defaultsFrom(found: { values?: Record<string, AttributeValue>; within?: Record<string, TypeDefaults> }): Pick<ParsedType, 'defaults'> {
  const defaults = Object.fromEntries(Object.entries(found).filter(([, record]) => Object.keys(record).length > 0));
  return Object.keys(defaults).length > 0 ? { defaults } : {};
}

/** A name written alone, as `string` is. */
function bareName(value: AttributeValue): string | undefined {
  const [step] = value.type === 'Reference' && value.value.length === 1 ? value.value : [];
  return step !== undefined && 'name' in step ? step.name : undefined;
}

/** Why a value that is neither a name nor a call is no type, at the part that makes it so. */
function notAType(value: AttributeValue): ConfigError {
  if (value.type === 'String' || value.type === 'Template') return new ConfigError('A type is written without quotes: string, not "string"', value.position);
  if (value.type === 'Binary') return new ConfigError('A type takes no operator', value.operatorPosition);
  if (value.type === 'Conditional') return new ConfigError('A type is written out, not chosen by a conditional', value.position);
  if (value.type === 'For') return new ConfigError('A type is written out, not made by a for', value.position);
  if (value.type === 'Reference' || value.type === 'Index') return new ConfigError('A type is a name or a call written alone, with no "." or "[" after it', value.position);

  return new ConfigError(A_TYPE, value.position);
}

/** The name a type is written with: `string` alone, or `list` before its `(`. */
function typeName(value: AttributeValue): string {
  if (value.type === 'Call') return value.name;

  const name = bareName(value);
  if (name === undefined) throw notAType(value);
  return name;
}

/** The one value written between a holding type's parentheses. */
function heldBy(call: CallNode, holds: string): AttributeValue {
  const [held, extra] = call.args;
  if (held === undefined) throw new ConfigError(A_TYPE, call.position);
  if (extra) throw new ConfigError(`Expect ')' after the type ${holds} holds.`, extra.position);

  return held;
}

function tupleTypes(call: CallNode, decode: Decode): ParsedType {
  const held = heldBy(call, 'tuple');
  if (held.type === 'For') throw notAType(held);
  if (held.type !== 'List') throw new ConfigError("Expect '[' after 'tuple('.", held.position);

  const within: Record<string, TypeDefaults> = {};
  const elements = held.value.map((item, index) => {
    const { type, defaults } = decode(item);
    if (defaults) within[index] = defaults;
    return type;
  });

  return { type: types.tuple(elements), ...defaultsFrom({ within }) };
}

/** `optional(type)` or `optional(type, default)`, read only as the type of an object's attribute. */
function attributeType(value: AttributeValue, decode: Decode): AttributeType {
  if (bareName(value) === 'optional') throw new ConfigError("Expect '(' after optional.", value.position);
  if (value.type !== 'Call' || value.name !== 'optional') return decode(value);

  const [written, given, extra] = value.args;
  if (written === undefined) throw new ConfigError(A_TYPE, value.position);
  if (extra) throw new ConfigError("Expect ')' after the type of optional, or its default.", extra.position);
  // Types are read at declaration, before any reference has a value.
  if (given) checkConstant(given, "An optional attribute's default");

  return { ...decode(written), optional: true, ...(given && { default: given }) };
}

function objectTypes(call: CallNode, decode: Decode): ParsedType {
  const held = heldBy(call, 'object');
  if (held.type === 'For') throw notAType(held);
  if (held.type !== 'Map') throw new ConfigError("Expect '{' after 'object('.", held.position);

  const attributes: Record<string, Type> = {};
  const optional: string[] = [];
  const values: Record<string, AttributeValue> = {};
  const within: Record<string, TypeDefaults> = {};
  for (const [name, written] of Object.entries(held.value)) {
    // A reference reads an attribute by its bare name, so an object type names each one that way.
    const quoted = held.quoted?.[name];
    if (quoted) throw new ConfigError('An object type names its attributes without quotes', quoted);

    const attribute = attributeType(written, decode);
    attributes[name] = attribute.type;
    if (attribute.optional) optional.push(name);
    if (attribute.default) values[name] = attribute.default;
    if (attribute.defaults) within[name] = attribute.defaults;
  }

  return { type: types.object(attributes, optional.length > 0 ? optional : undefined), ...defaultsFrom({ values, within }) };
}

function holdingType(call: CallNode, decode: Decode): ParsedType {
  if (call.name === 'tuple') return tupleTypes(call, decode);
  if (call.name === 'object') return objectTypes(call, decode);

  const { type, defaults } = decode(heldBy(call, call.name));
  return { type: COLLECTIONS[call.name](type), ...(defaults && { defaults: { element: defaults } }) };
}

/** A type is read from a value written like any other, as `list(string)` is a call, so the parser needs no grammar of its own for it. */
export function decodeType(value: AttributeValue): ParsedType {
  const name = typeName(value);
  if (name === 'optional') throw new ConfigError("optional(...) is written only as the type of an object's attribute", value.position);

  const primitive = PRIMITIVE_TYPES.get(name);
  if (primitive && value.type === 'Call') throw new ConfigError(`${name} holds no other type, so it takes no '('`, value.position);
  if (primitive) return { type: primitive };
  if (!HOLDING_TYPES.has(name)) throw new ConfigError(`"${name}" is not a type: a type is string, number, bool, any, list, set, map, tuple or object`, value.position);
  if (value.type !== 'Call') throw new ConfigError(`Expect '(' after ${name}.`, value.position);

  return holdingType(value, decodeType);
}
