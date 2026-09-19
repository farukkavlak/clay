/** How a node is addressed in the dependency graph. Keys are built here and never taken apart. */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars.${name}` : `vars.${name}`;
}

export function outputKey(scope: string, name: string): string {
  return scope ? `${scope}.outputs.${name}` : `outputs.${name}`;
}

export function childScope(scope: string, moduleName: string): string {
  return scope ? `${scope}.module.${moduleName}` : `module.${moduleName}`;
}
