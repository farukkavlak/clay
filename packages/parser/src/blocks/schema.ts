import { LocalBlock, Statement } from '../ast';
import { Attribute, Block, Header, Inside, Schema } from '../body';
import { checkKey } from '../checkKey';
import { ConfigError } from '../ConfigError';
import { attributesOnly, refuseBlock } from './attributes';
import { decodeData } from './decodeData';
import { decodeModule } from './decodeModule';
import { decodeOutput, outputRules } from './decodeOutput';
import { decodeResource, lifecycleArgument } from './decodeResource';
import { checkValidationArgument, decodeValidation } from './decodeValidation';
import { checkVariableName, decodeVariable, variableRules } from './decodeVariable';
import { LabelRule, labelsOf } from './labels';
import { checkTypedBlock, typedAttribute, TypedRules } from './typedBody';

/** A kind of block: its labels, what is said where its `{` is missing, and what it means once read. */
interface Kind {
  labels: LabelRule[];
  opening: string;
  checkLabels?: (header: Header) => void;
  decode: (block: Block, labels: string[]) => Statement[];
}

/** A statement for each name, so several blocks merge and a name set twice is a duplicate like any other. */
function decodeLocals(block: Block): LocalBlock[] {
  return attributesOnly(block.body).map(({ name, value, position }) => ({ type: 'Local', name, value, position }));
}

const typeAndName = (kind: string, what: string): LabelRule[] => [
  { missing: `Expect ${what} type string after '${kind}'.`, word: 'type' },
  { missing: `Expect ${what} name string after ${what} type.`, word: 'name' },
];

const named = (kind: string): LabelRule[] => [{ missing: `Expect ${kind} name string after '${kind}'.`, word: 'name' }];

/** The blocks a file takes. A Map, so `toString` is no kind. */
const KINDS = new Map<string, Kind>([
  ['resource', { labels: typeAndName('resource', 'resource'), opening: "Expect '{' after resource name.", decode: (block, labels) => [decodeResource(block, labels)] }],
  ['data', { labels: typeAndName('data', 'data source'), opening: "Expect '{' after data source name.", decode: (block, labels) => [decodeData(block, labels)] }],
  [
    'variable',
    {
      labels: named('variable'),
      opening: "Expect '{' after variable name.",
      checkLabels: ({ labels: [name] }) => checkVariableName(name),
      decode: (block, labels) => [decodeVariable(block, labels)],
    },
  ],
  ['output', { labels: named('output'), opening: "Expect '{' after output name.", decode: (block, labels) => [decodeOutput(block, labels)] }],
  ['module', { labels: named('module'), opening: "Expect '{' after module name.", decode: (block, labels) => [decodeModule(block, labels)] }],
  ['locals', { labels: [], opening: "Expect '{' after 'locals'.", decode: decodeLocals }],
]);

function kindOf(header: Header): Kind {
  const kind = KINDS.get(header.name);
  if (kind === undefined) throw new ConfigError(`Unexpected token: ${header.name}`, header.position);

  return kind;
}

/** A variable's or an output's body, which takes only what its rules name. */
function typedRules({ name, labels }: Header): TypedRules | undefined {
  if (name === 'variable') return variableRules(labels[0].value);
  if (name === 'output') return outputRules(labels[0].value);

  return undefined;
}

const spellHeader = ({ name, labels }: Header) => [name, ...labels.map((label) => `"${label.value}"`)].join(' ');

function checkFileBlock(header: Header, opened: boolean): void {
  const kind = kindOf(header);
  labelsOf(header, kind.labels);
  kind.checkLabels?.(header);

  const extra = header.labels[kind.labels.length];
  if (extra) throw new ConfigError(kind.opening, extra.position);
  if (!opened) throw new ConfigError(kind.opening, header.open);
}

/** Only a resource takes a block, one `lifecycle`, and only a variable its `validation`. */
function checkInnerBlock(header: Header, { block: within, before }: Inside): void {
  if (within.name === 'resource' && header.name === 'lifecycle' && header.labels.length === 0) {
    if (before.some((item) => item.type === 'Block')) throw new ConfigError(`${spellHeader(within)} has two lifecycle blocks`, header.position);
    return;
  }

  const rules = typedRules(within);
  if (rules) checkTypedBlock(header, rules);
  else refuseBlock(header);
}

/** Each name once in a body; the locals of a module are named once across every block, which is checked as each is read. */
function checkNew({ name, position }: Attribute, { block, before }: Inside): void {
  if (block.name === 'locals') return;

  checkKey(Object.fromEntries(attributesOnly(before).map((item) => [item.name, true])), { value: name, position });
}

/** What each kind of block takes, checked as each part of it is read. */
export const SCHEMA: Schema = {
  header(header, opened, inside) {
    if (inside === undefined) checkFileBlock(header, opened);
    else checkInnerBlock(header, inside);
  },

  attribute(attribute, inside) {
    checkNew(attribute, inside);

    const { name } = inside.block;
    const rules = typedRules(inside.block);
    if (name === 'lifecycle') lifecycleArgument(attribute);
    else if (name === 'validation') checkValidationArgument(attribute.name, attribute.value);
    else if (rules) typedAttribute(attribute.name, attribute.value, rules);
  },

  closed(block, { block: within }) {
    if (block.name === 'validation') decodeValidation(block, within.labels[0].value);
  },
};

/** What a block the schema has checked means, read as soon as its body closes. */
export function decodeBlock(block: Block): Statement[] {
  return kindOf(block).decode(
    block,
    block.labels.map((label) => label.value)
  );
}
