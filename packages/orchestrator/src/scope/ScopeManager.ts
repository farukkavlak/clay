import { Address } from '../Address';
import { childScope } from '../keys';

export interface VariableValue {
  value: unknown;
  context: Address;
}

export class ScopeManager {
  private variables: Map<string, Map<string, VariableValue>> = new Map();
  private outputs: Map<string, Map<string, unknown>> = new Map();

  getScope(address?: Address): string {
    if (!address) return '';
    return address.modulePath.reduce((scope, moduleName) => childScope(scope, moduleName), '');
  }

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

  getAllVariables(): Map<string, Map<string, VariableValue>> {
    return this.variables;
  }

  clear(): void {
    this.variables.clear();
    this.outputs.clear();
  }
}
