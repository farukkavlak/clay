import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type Graph = ReadonlyMap<string, readonly string[]>;

export interface Cycles {
  readonly files: string[][];
  readonly folders: string[][];
}

function resolved(from: string, name: string): string {
  const base = path.join(path.dirname(from), name);
  const found = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`${from} imports ${name}, which is no file`);

  return found;
}

/** A package is imported by its name, so only a relative import can close a cycle inside one. */
function importsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'));

  return importedFiles.filter(({ fileName }) => fileName.startsWith('.')).map(({ fileName }) => resolved(file, fileName));
}

function reachable(graph: Graph, from: string): Set<string> {
  const seen = new Set<string>();
  const next = [...(graph.get(from) ?? [])];
  for (let node = next.pop(); node !== undefined; node = next.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    next.push(...(graph.get(node) ?? []));
  }

  return seen;
}

/** Each group of nodes that reach one another, named once. */
function cyclesIn(graph: Graph): string[][] {
  const reach = new Map([...graph.keys()].map((node) => [node, reachable(graph, node)]));
  const groups = new Map<string, string[]>();
  for (const [node, from] of reach) {
    if (!from.has(node)) continue;
    const group = [...from].filter((other) => reach.get(other)?.has(node)).sort();
    groups.set(group.join(','), group);
  }

  return [...groups.values()];
}

/** A file beside the folders stands for itself, so a cycle through a folder is found even where no two files import each other. */
function folderGraph(src: string, files: Graph): Graph {
  const unit = (file: string) => (path.dirname(file) === src ? file : path.dirname(file));
  const graph = new Map<string, string[]>();
  for (const [file, imports] of files) {
    const from = unit(file);
    graph.set(from, [...(graph.get(from) ?? []), ...imports.map((to) => unit(to)).filter((to) => to !== from)]);
  }

  return graph;
}

const throughFolder = (cycle: string[]) => cycle.some((node) => !node.endsWith('.ts'));

/** The import cycles in the TypeScript under `src`, named relative to it. A cycle of files beside the folders is a file cycle only. */
export function importCycles(src: string): Cycles {
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(src, file));
  const graph = new Map(files.map((file) => [file, importsOf(file)]));
  const named = (cycles: string[][]) => cycles.map((cycle) => cycle.map((node) => path.relative(src, node)));

  return { files: named(cyclesIn(graph)), folders: named(cyclesIn(folderGraph(src, graph)).filter((cycle) => throughFolder(cycle))) };
}
