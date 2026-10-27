import { AttributePath, EVERY_ITEM } from '@clay/contracts';

/**
 * Paths by their steps, so a path is found by walking its own steps and not by holding it against every other.
 * Steps meet by how they are spelled, so a walk may find more than it asked for, never less.
 */
export class PathTree {
  private readonly ends: AttributePath[] = [];
  private readonly children = new Map<string, PathTree>();

  constructor(paths: readonly AttributePath[] = []) {
    for (const path of paths) this.add(path, 0);
  }

  /** The paths that end here. */
  get paths(): readonly AttributePath[] {
    return this.ends;
  }

  child(step: string | number): PathTree | undefined {
    return this.children.get(String(step));
  }

  /** Every path that ends here or below. */
  *all(): Generator<AttributePath> {
    yield* this.ends;
    for (const child of this.children.values()) yield* child.all();
  }

  /** The nodes reached at each depth, from this one down to where `steps` end. Where `everyItem`, a step every item here meets any step. */
  levels(steps: AttributePath, everyItem: boolean): PathTree[][] {
    const levels: PathTree[][] = [[this]];
    for (const [depth, step] of steps.entries()) levels.push(levels[depth].flatMap((node) => node.next(step, everyItem)));

    return levels;
  }

  private next(step: string | number, everyItem: boolean): PathTree[] {
    const every = everyItem && String(step) !== String(EVERY_ITEM) ? this.child(EVERY_ITEM) : undefined;

    return [this.child(step), every].filter((node): node is PathTree => node !== undefined);
  }

  /** Adds `path` here, where its steps before `depth` led. */
  private add(path: AttributePath, depth: number): void {
    if (depth === path.length) {
      this.ends.push(path);
      return;
    }

    const step = String(path[depth]);
    const child = this.children.get(step) ?? new PathTree();
    this.children.set(step, child);
    child.add(path, depth + 1);
  }
}
