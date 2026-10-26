import { Address, AttributePath, EVERY_ITEM, ModuleAddress, Schema, Type, types, UNKNOWN } from '@clay/contracts';
import {
  AttributeValue,
  CountReference,
  DataBlock,
  DataReference,
  EachReference,
  ModuleBlock,
  ModuleOutputReference,
  OutputBlock,
  Position,
  ResourceBlock,
  ResourceReference,
  spell,
  Step,
  VariableReference,
} from '@clay/parser';

import { converted } from '../../values/conformValues';
import { declaredOf, givenTo } from '../../values/declared';
import { Instances, Repetition } from '../../instances/Instances';
import { blockKey, callKey, Context, DataInstance, dataSourceKey, ModuleCall, moduleOf, scopeOf } from '../../keys';
import { ModuleInstances } from '../../instances/ModuleInstances';
import { placed } from '../../place';
import { DeclaredBlock, ScopeManager } from '../../config/ScopeManager';
import { Value, valueOf, withSensitive } from '../../values/Value';
import { itemsOf, sharedMarks } from '../../values/sensitive';
import { everyOf, everyType, instanceType, noAttribute, outputsType, readCall, readInstance } from './instance';

/** Paths are known at load and a local is read as written, so they are not here. */
type Unread = VariableReference | DataReference | ModuleOutputReference | ResourceReference | CountReference | EachReference;

/** A value written once for every instance, whose marks a reference takes at `at` once it is held as an instance holds it. */
export interface Source {
  value: AttributeValue;
  context: Context;
  declaration: string;
  held: (read: Value, readNode: (node: AttributeValue) => Value) => Value;
  at: AttributePath;
}

/** What every instance gives a reference: its type, the parts its declaration marks, and the values whose marks it takes. */
export interface Written {
  type: Type;
  sensitive: AttributePath[];
  from: Source[];
  path: Step[];
}

type Values = ReadonlyMap<string, Omit<Source, 'at'>>;

/** Held in the output's type, with its defaults, as an instance holds it. */
function outputSource(block: OutputBlock, call: ModuleAddress): Omit<Source, 'at'> {
  return { value: block.value, context: call, declaration: spell(block), held: (read, readNode) => givenTo('output', block.name, read, declaredOf(block), readNode) };
}

/** The value named, or each at its name, under every instance where the reference names none. */
function sourcesOf(values: Values, every: Repetition | undefined, name: string | undefined): Source[] {
  if (name !== undefined) {
    const one = values.get(name);
    return one ? [{ ...one, at: [] }] : [];
  }

  return [...values].map(([each, value]) => ({ ...value, at: every ? [EVERY_ITEM, each] : [each] }));
}

const WHOLE: AttributePath[] = [[]];

/** The parts named `sensitive`, under every instance where the reference names none. */
function marked(names: string[], every?: Repetition): AttributePath[] {
  return names.map((name) => (every ? [EVERY_ITEM, name] : [name]));
}

const sensitiveIn = (schema: Schema) => Object.keys(schema).filter((name) => schema[name].sensitive === true);

/** Every instance, the whole instance where the reference names no attribute, or the attribute. */
function fromSchema(schema: Schema, every: Repetition | undefined, attribute: string | undefined): Pick<Written, 'type' | 'sensitive'> {
  if (every) return { type: everyType(every, schema), sensitive: marked(sensitiveIn(schema), every) };
  if (attribute === undefined) return { type: instanceType(schema), sensitive: marked(sensitiveIn(schema)) };

  return { type: schema[attribute].type, sensitive: schema[attribute].sensitive === true ? WHOLE : [] };
}

/** Types and declared marks for references read as written, before any instance exists. */
export class WrittenTypes {
  constructor(
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  typeOf(reference: Unread, where: Context, position: Position): Written {
    const module = moduleOf(where);

    if (reference.kind === 'variable') return this.variableType(reference, scopeOf(module.withoutKeys()));
    if (reference.kind === 'count') return { type: types.number, sensitive: [], from: [], path: reference.path };
    if (reference.kind === 'each') return this.eachType(reference, where);
    if (reference.kind === 'module') return this.callType(reference, where, position);
    if (reference.kind === 'data') return this.dataType(reference, where, position);

    return this.resourceType(reference, where, position);
  }

  /** The graph has already refused undeclared variables; each is declared once for all instances of its module. */
  private variableType(reference: VariableReference, scope: string): Written {
    const variable = this.scopeManager.getVariable(scope, reference.name)!;
    const { type = types.dynamic, sensitive, value, context, block } = variable;
    const held: Source['held'] = (read, readNode) => givenTo('variable', reference.name, read, variable, readNode);

    return { type, sensitive: sensitive ? WHOLE : [], from: [{ value, context, declaration: block, held, at: [] }], path: reference.path };
  }

  /** `each.value` is one of the items of the for_each, not known which; the graph has already refused `each` outside a block with one. */
  private eachType(reference: EachReference, where: Context): Written {
    if (reference.name === 'key') return { type: types.string, sensitive: [], from: [], path: reference.path };

    const { block, context } = this.repeated(where);
    const held: Source['held'] = (read) => withSensitive(valueOf(types.dynamic, UNKNOWN), sharedMarks(itemsOf(read)));
    return { type: types.dynamic, sensitive: [], from: [{ value: block.forEach!, context, declaration: spell(block), held, at: [] }], path: reference.path };
  }

  /** The block `where` is in, and where its for_each is read; the graph refuses `each` anywhere else first. */
  private repeated(where: Context): DeclaredBlock<ResourceBlock | DataBlock | ModuleBlock> {
    if (where instanceof ModuleCall) return this.scopeManager.declaredCall(callKey(where.call.withoutKeys()))!;
    if (where instanceof DataInstance) return this.scopeManager.declaredBlock(dataSourceKey(scopeOf(where.module.withoutKeys()), where.type, where.name))!;
    if (where instanceof Address) return this.scopeManager.declaredBlock(blockKey(where))!;

    throw new Error('each.value was read outside a block');
  }

  /** The graph has already refused undeclared data sources, and every one has its schema. */
  private dataType(reference: DataReference, where: Context, position: Position): Written {
    const spelled = `data.${reference.type}.${reference.name}`;
    const key = dataSourceKey(scopeOf(moduleOf(where).withoutKeys()), reference.type, reference.name);
    const { every, attribute, path } = readInstance(spelled, reference.path, this.instances.repetitionOf(key), position);
    const schema = this.dataSchemas.get(reference.type)!;
    if (attribute !== undefined && !Object.hasOwn(schema, attribute)) throw placed(`Attribute "${attribute}" not found on data source "${spelled}"`, position);

    return { ...fromSchema(schema, every, attribute), from: sourcesOf(this.valuesOf(key, schema), every, attribute), path };
  }

  /** An output that names no type is `dynamic`. */
  private callType(reference: ModuleOutputReference, where: Context, position: Position): Written {
    const call = moduleOf(where).child(reference.module).withoutKeys();
    const { every, output, path } = readCall(reference, this.modules.repetitionOf(call), position);
    const outputs = this.scopeManager.outputsOf(scopeOf(call));
    const blocks = [...this.scopeManager.outputBlocksOf(scopeOf(call)).values()];
    const sensitive = blocks.filter((block) => block.sensitive).map((block) => block.name);
    const from = sourcesOf(new Map(blocks.map((block) => [block.name, outputSource(block, call)])), every, output);
    if (every) return { type: everyOf(every, outputsType(outputs)), sensitive: marked(sensitive, every), from, path };
    if (output === undefined) return { type: outputsType(outputs), sensitive: marked(sensitive), from, path };

    // The graph has already refused undeclared outputs.
    return { type: outputs.get(output)!, sensitive: sensitive.includes(output) ? WHOLE : [], from, path };
  }

  /** The type of the attribute, of the whole instance where the reference names none, or of every instance where it names no instance. */
  private resourceType(reference: ResourceReference, where: Context, position: Position): Written {
    const block = blockKey(new Address(moduleOf(where), reference.type, reference.name));
    const { every, attribute, path } = readInstance(`${reference.type}.${reference.name}`, reference.path, this.instances.repetitionOf(block), position);
    // Every schema is loaded by now.
    const schema = this.schemas.get(reference.type)!;
    if (attribute !== undefined && !Object.hasOwn(schema, attribute)) throw placed(noAttribute(reference.type, attribute), position);

    return { ...fromSchema(schema, every, attribute), from: sourcesOf(this.valuesOf(block, schema), every, attribute), path };
  }

  /** Every block is declared at load, and each value is held in the type its schema gives it. */
  private valuesOf(key: string, schema: Schema): Values {
    const { block, context } = this.scopeManager.declaredBlock(key)!;
    const type = block.type === 'Resource' ? block.resourceType : block.dataSourceType;
    const declaration = spell(block);

    return new Map(
      Object.entries(block.attributes).map(([name, value]) => [name, { value, context, declaration, held: (read: Value) => converted(type, read, schema[name].type, [name]) }])
    );
  }
}
