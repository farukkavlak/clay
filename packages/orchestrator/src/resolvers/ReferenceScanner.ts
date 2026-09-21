import { Address } from '@clay/contracts';
import { childScope, outputKey, variableKey } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';

/** What a config value reads from, with the graph key it is addressed by. */
export type Reference =
  | { kind: 'resource'; key: string; address: string }
  | { kind: 'variable'; key: string; name: string }
  | { kind: 'output'; key: string; scope: string; module: string; name: string };

export class ReferenceScanner {
  constructor(private scopeManager: ScopeManager) {}

  referencesIn(value: unknown, context: Address): Reference[] {
    const references: Reference[] = [];
    this.collect(value, context, references);
    return references;
  }

  private collect(value: unknown, context: Address, references: Reference[]): void {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) for (const item of value) this.collect(item, context, references);
    else this.collectFromObject(value as Record<string, unknown>, context, references);
  }

  private collectFromObject(obj: Record<string, unknown>, context: Address, references: Reference[]): void {
    if (obj.type === 'Reference' && Array.isArray(obj.value)) this.addReference(obj.value as string[], context, references);
    else if ((obj.type === 'Interpolation' || obj.type === 'String') && typeof obj.value === 'string') this.addInterpolations(obj.value, context, references);
    else for (const item of Object.values(obj)) this.collect(item, context, references);
  }

  private addInterpolations(content: string, context: Address, references: Reference[]): void {
    const regex = /\${([^}]+)}/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) this.addReference(match[1].trim().split('.'), context, references);
  }

  private addReference(refParts: string[], context: Address, references: Reference[]): void {
    const refType = refParts[0];
    if (refType === 'data') return;

    const scope = this.scopeManager.getScope(context);

    if (refType === 'var') references.push({ kind: 'variable', key: variableKey(scope, refParts[1]), name: refParts[1] });
    else if (refType === 'module') {
      // A module reference is module.<name>.<output> and nothing deeper.
      if (refParts.length > 3) throw new Error(`Reference "${refParts.join('.')}" reaches into a module; modules are read through their outputs`);

      const [, module, name] = refParts;
      const child = childScope(scope, module);
      references.push({ kind: 'output', key: outputKey(child, name), scope: child, module, name });
    } else {
      const address = new Address(context.modulePath, refParts[0], refParts[1]).toString();
      references.push({ kind: 'resource', key: address, address });
    }
  }
}
