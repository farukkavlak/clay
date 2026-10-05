import { ModuleAddress, Type } from '@clay/contracts';
import { AttributeValue, TypeDefaults } from '@clay/parser';

import { ModuleCall } from '../keys';
import { Value } from '../Value';

/** Resolved where it is written: an input in the call, a default in its own module. */
export interface VariableValue {
  value: AttributeValue;
  context: ModuleAddress | ModuleCall;
  type?: Type;
  defaults?: TypeDefaults;
  block: string;
}

/** Variables per module, since each instance reads the same values; outputs per instance, since each has its own. */
export class ScopeManager {
  private variables: Map<string, Map<string, VariableValue>> = new Map();
  private outputs: Map<string, Map<string, Value>> = new Map();
  private directories: Map<string, string> = new Map();

  setVariable(scope: string, name: string, value: VariableValue): void {
    if (!this.variables.has(scope)) this.variables.set(scope, new Map());
    this.variables.get(scope)!.set(name, value);
  }

  getVariable(scope: string, name: string): VariableValue | undefined {
    return this.variables.get(scope)?.get(name);
  }

  setOutput(scope: string, name: string, value: Value): void {
    if (!this.outputs.has(scope)) this.outputs.set(scope, new Map());
    this.outputs.get(scope)!.set(name, value);
  }

  getOutput(scope: string, name: string): Value | undefined {
    return this.outputs.get(scope)?.get(name);
  }

  setDirectory(scope: string, directory: string): void {
    this.directories.set(scope, directory);
  }

  getDirectory(scope: string): string | undefined {
    return this.directories.get(scope);
  }

  clear(): void {
    this.variables.clear();
    this.outputs.clear();
    this.directories.clear();
  }
}
