import { Address } from '../Address';
import { ScopeManager } from '../scope/ScopeManager';

/** Finds the resources and module outputs a config value reads from. */
export class ReferenceScanner {
  constructor(private scopeManager: ScopeManager) {}

  keysIn(value: unknown, context: Address): string[] {
    const keys: string[] = [];
    this.collect(value, context, keys);
    return keys;
  }

  private collect(value: unknown, context: Address, keys: string[]): void {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) for (const item of value) this.collect(item, context, keys);
    else this.collectFromObject(value as Record<string, unknown>, context, keys);
  }

  private collectFromObject(obj: Record<string, unknown>, context: Address, keys: string[]): void {
    if (obj.type === 'Reference' && Array.isArray(obj.value)) this.addReference(obj.value as string[], context, keys);
    else if ((obj.type === 'Interpolation' || obj.type === 'String') && typeof obj.value === 'string') this.addInterpolations(obj.value, context, keys);
    else for (const item of Object.values(obj)) this.collect(item, context, keys);
  }

  private addInterpolations(content: string, context: Address, keys: string[]): void {
    const regex = /\${([^}]+)}/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) this.addReference(match[1].trim().split('.'), context, keys);
  }

  private addReference(refParts: string[], context: Address, keys: string[]): void {
    const refType = refParts[0];
    if (refType === 'var' || refType === 'data') return;

    if (refType === 'module') {
      const [, moduleName, outputName] = refParts;
      const scope = this.scopeManager.getScope(context);
      const childScope = scope ? `${scope}.module.${moduleName}` : `module.${moduleName}`;
      keys.push(`${childScope}.outputs.${outputName}`);
      return;
    }

    keys.push(new Address(context.modulePath, refParts[0], refParts[1]).toString());
  }
}
