import { Type } from '@clay/provider';
import { ModuleAddress } from '@clay/core';
import { AttributeValue, DataBlock, LocalBlock, ModuleBlock, OutputBlock, Position, ResourceBlock, TypeDefaults, Validation } from '@clay/parser';

import { callKey, Context, ModuleCall } from '../keys';
import { Value } from '../values/Value';
import { Versions } from '../values/Versions';

/** Resolved where it is written: an input in the call, a default in its own module. */
export interface VariableValue {
  /** Left out only where a check is given no value for a root variable, which is then unknown. */
  value?: AttributeValue;
  /** Where the value is written, or the variable's block where it has none. */
  position: Position;
  context: ModuleAddress | ModuleCall;
  type?: Type;
  defaults?: TypeDefaults;
  sensitive?: true;
  block: string;
  /** The variable's rules, and its own block, where a mistake in one is placed. */
  validations?: { rules: readonly Validation[]; declaration: string };
}

/** A resource, data source or module call block, and where what it is given is read. */
export interface DeclaredBlock<B = ResourceBlock | DataBlock> {
  block: B;
  context: Context;
}

const named = (scope: string) => scope || 'the root module';

/** Variables per module, since each instance reads the same values; locals and outputs per instance, since each has its own. */
export class ScopeManager {
  private variables: Map<string, Map<string, VariableValue>> = new Map();
  private outputs: Map<string, Map<string, Value>> = new Map();
  private declaredLocals: Map<string, Map<string, LocalBlock>> = new Map();
  private locals: Map<string, Map<string, Value>> = new Map();
  private declaredOutputs: Map<string, { types: ReadonlyMap<string, Type>; blocks: ReadonlyMap<string, OutputBlock> }> = new Map();
  private declaredBlocks: Map<string, DeclaredBlock> = new Map();
  private declaredCalls: Map<string, DeclaredBlock<ModuleBlock>> = new Map();
  private directories: Map<string, string> = new Map();

  constructor(private versions: Versions) {}

  setVariable(scope: string, name: string, value: VariableValue): void {
    if (!this.variables.has(scope)) this.variables.set(scope, new Map());
    this.variables.get(scope)!.set(name, value);
  }

  getVariable(scope: string, name: string): VariableValue | undefined {
    return this.variables.get(scope)?.get(name);
  }

  /** The graph refuses an undeclared variable before anything reads one. */
  declaredVariable(scope: string, name: string): VariableValue {
    const variable = this.getVariable(scope, name);
    if (variable === undefined) throw new Error(`variable "${name}" is not declared in ${named(scope)}, which is a bug`);

    return variable;
  }

  /** Per module, not per instance: every instance declares the same locals. */
  declareLocal(scope: string, local: LocalBlock): void {
    if (!this.declaredLocals.has(scope)) this.declaredLocals.set(scope, new Map());
    this.declaredLocals.get(scope)!.set(local.name, local);
  }

  /** The graph refuses an undeclared local before anything reads one. */
  declaredLocal(scope: string, name: string): LocalBlock {
    const local = this.declaredLocals.get(scope)?.get(name);
    if (local === undefined) throw new Error(`local "${name}" is not declared in ${named(scope)}, which is a bug`);

    return local;
  }

  setLocal(scope: string, name: string, value: Value): void {
    if (!this.locals.has(scope)) this.locals.set(scope, new Map());
    this.locals.get(scope)!.set(name, value);
  }

  getLocal(scope: string, name: string): Value | undefined {
    return this.locals.get(scope)?.get(name);
  }

  setOutput(instance: ModuleAddress, name: string, value: Value): void {
    const scope = instance.toString();
    if (!this.outputs.has(scope)) this.outputs.set(scope, new Map());
    this.outputs.get(scope)!.set(name, value);
    // Nothing reads every instance of the root module.
    if (!instance.isRoot()) this.versions.changed(callKey(instance));
  }

  getOutput(scope: string, name: string): Value | undefined {
    return this.outputs.get(scope)?.get(name);
  }

  /** Per module, not per instance: every instance declares the same outputs. */
  declareOutputs(scope: string, outputs: ReadonlyMap<string, Type>, blocks: ReadonlyMap<string, OutputBlock>): void {
    this.declaredOutputs.set(scope, { types: outputs, blocks });
  }

  outputBlocksOf(scope: string): ReadonlyMap<string, OutputBlock> {
    return this.declaredOutputs.get(scope)?.blocks ?? new Map();
  }

  /** Per block, not per instance: every instance is given the same values. */
  declareBlock(key: string, block: DeclaredBlock): void {
    this.declaredBlocks.set(key, block);
  }

  /** Every block is declared at load, before anything reads one. */
  declaredBlock(key: string): DeclaredBlock {
    const block = this.declaredBlocks.get(key);
    if (block === undefined) throw new Error(`${key} is not declared, which is a bug`);

    return block;
  }

  /** Per call, not per instance of the module that makes it. */
  declareCall(key: string, call: DeclaredBlock<ModuleBlock>): void {
    this.declaredCalls.set(key, call);
  }

  /** Every module call is declared at load, before anything reads one. */
  declaredCall(key: string): DeclaredBlock<ModuleBlock> {
    const call = this.declaredCalls.get(key);
    if (call === undefined) throw new Error(`${key} is not declared, which is a bug`);

    return call;
  }

  /** Each output's type, `dynamic` where it names none. */
  outputsOf(scope: string): ReadonlyMap<string, Type> {
    return this.declaredOutputs.get(scope)?.types ?? new Map();
  }

  setDirectory(scope: string, directory: string): void {
    this.directories.set(scope, directory);
  }

  /** Every called module is loaded, with its directory, before anything in it is read. */
  getDirectory(scope: string): string {
    const directory = this.directories.get(scope);
    if (directory === undefined) throw new Error(`the directory of ${named(scope)} is not loaded, which is a bug`);

    return directory;
  }
}
