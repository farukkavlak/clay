import { Address } from '@clay/contracts';

export interface VariableValue {
  value: unknown;
  context: Address;
}

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
