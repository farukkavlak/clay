import { ModuleAddress } from '@clay/contracts';

import { ModuleCall } from '../keys';

/** A variable's value as written, and where it is read: in the module itself for a default, in the call for an input. */
export interface VariableValue {
  value: unknown;
  context: ModuleAddress | ModuleCall;
}

/** Variables by the module as the configuration writes it, since each instance reads the same values; outputs by the instance, since each comes to its own. */
export class ScopeManager {
  private variables: Map<string, Map<string, VariableValue>> = new Map();
  private outputs: Map<string, Map<string, unknown>> = new Map();

  setVariable(scope: string, name: string, value: VariableValue): void {
    if (!this.variables.has(scope)) this.variables.set(scope, new Map());
    this.variables.get(scope)!.set(name, value);
  }

  getVariable(scope: string, name: string): VariableValue | undefined {
    return this.variables.get(scope)?.get(name);
  }

  setOutput(scope: string, name: string, value: unknown): void {
    if (!this.outputs.has(scope)) this.outputs.set(scope, new Map());
    this.outputs.get(scope)!.set(name, value);
  }

  getOutput(scope: string, name: string): unknown | undefined {
    return this.outputs.get(scope)?.get(name);
  }

  clear(): void {
    this.variables.clear();
    this.outputs.clear();
  }
}
