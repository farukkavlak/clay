import { Address, AttributePath, EVERY_ITEM, Schema, Type, types } from '@clay/contracts';
import { CountReference, DataReference, EachReference, ModuleOutputReference, Position, ResourceReference, Step, VariableReference } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { blockKey, Context, dataSourceKey, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { placed } from '../place';
import { ScopeManager } from '../scope/ScopeManager';
import { everyOf, everyType, instanceType, noAttribute, outputsType, readCall, readInstance } from './instance';

/** Paths are known at load and a local is read as written, so they are not here. */
type Unread = VariableReference | DataReference | ModuleOutputReference | ResourceReference | CountReference | EachReference;

/** What every instance gives a reference: its type, and the parts its declaration marks. */
export interface Written {
  type: Type;
  sensitive: AttributePath[];
  path: Step[];
}

const WHOLE: AttributePath[] = [[]];

/** The parts named `sensitive`, under every instance where the reference names none. */
function marked(names: string[], every?: Repetition): AttributePath[] {
  return names.map((name) => (every ? [EVERY_ITEM, name] : [name]));
}

const sensitiveIn = (schema: Schema) => Object.keys(schema).filter((name) => schema[name].sensitive === true);

/** Every instance, the whole instance where the reference names no attribute, or the attribute. */
function fromSchema(schema: Schema, every: Repetition | undefined, attribute: string | undefined): Omit<Written, 'path'> {
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
    if (reference.kind === 'count') return { type: types.number, sensitive: [], path: reference.path };
    if (reference.kind === 'each') return { type: reference.name === 'key' ? types.string : types.dynamic, sensitive: [], path: reference.path };
    if (reference.kind === 'module') return this.callType(reference, where, position);
    if (reference.kind === 'data') return this.dataType(reference, where, position);

    return this.resourceType(reference, where, position);
  }

  /** The graph has already refused undeclared variables; each is declared once for all instances of its module. */
  private variableType(reference: VariableReference, scope: string): Written {
    const { type = types.dynamic, sensitive } = this.scopeManager.getVariable(scope, reference.name)!;

    return { type, sensitive: sensitive ? WHOLE : [], path: reference.path };
  }

  /** The graph has already refused undeclared data sources, and every one has its schema. */
  private dataType(reference: DataReference, where: Context, position: Position): Written {
    const spelled = `data.${reference.type}.${reference.name}`;
    const repetition = this.instances.repetitionOf(dataSourceKey(scopeOf(moduleOf(where).withoutKeys()), reference.type, reference.name));
    const { every, attribute, path } = readInstance(spelled, reference.path, repetition, position);
    const schema = this.dataSchemas.get(reference.type)!;
    if (attribute !== undefined && !Object.hasOwn(schema, attribute)) throw placed(`Attribute "${attribute}" not found on data source "${spelled}"`, position);

    return { ...fromSchema(schema, every, attribute), path };
  }

  /** An output that names no type is `dynamic`. */
  private callType(reference: ModuleOutputReference, where: Context, position: Position): Written {
    const call = moduleOf(where).child(reference.module).withoutKeys();
    const { every, output, path } = readCall(reference, this.modules.repetitionOf(call), position);
    const outputs = this.scopeManager.outputsOf(scopeOf(call));
    const sensitive = this.scopeManager.sensitiveOutputsOf(scopeOf(call));
    if (every) return { type: everyOf(every, outputsType(outputs)), sensitive: marked([...sensitive], every), path };
    if (output === undefined) return { type: outputsType(outputs), sensitive: marked([...sensitive]), path };

    // The graph has already refused undeclared outputs.
    return { type: outputs.get(output)!, sensitive: sensitive.has(output) ? WHOLE : [], path };
  }

  /** The type of the attribute, of the whole instance where the reference names none, or of every instance where it names no instance. */
  private resourceType(reference: ResourceReference, where: Context, position: Position): Written {
    const block = blockKey(new Address(moduleOf(where), reference.type, reference.name));
    const { every, attribute, path } = readInstance(`${reference.type}.${reference.name}`, reference.path, this.instances.repetitionOf(block), position);
    // Every schema is loaded by now.
    const schema = this.schemas.get(reference.type)!;
    if (attribute !== undefined && !Object.hasOwn(schema, attribute)) throw placed(noAttribute(reference.type, attribute), position);

    return { ...fromSchema(schema, every, attribute), path };
  }
}
