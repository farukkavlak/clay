import type { AttributePath } from './AttributePath';
import { EVERY_ITEM, EXACT, isMarker, isMaybe, MAYBE } from './markers';

/** A path as it was given, and where it stood among them, so what is left of the paths keeps their order. */
interface Entry {
  readonly seq: number;
  readonly path: AttributePath;
}

/** A marker is no key, though a key may be spelled as one. */
const stepKey = (step: string | number) => (isMarker(step) ? `m${step}` : `s${String(step)}`);

class Node {
  readonly children = new Map<string, Node>();
  /** The paths whose last step leads here. */
  readonly ends: Entry[] = [];

  child(step: string | number): Node | undefined {
    return this.children.get(stepKey(step));
  }

  /** The key or place `step` names, even where it is spelled as a marker. */
  named(step: string | number): Node | undefined {
    return this.children.get(`s${String(step)}`);
  }

  /** Whether a path ends at the step under this one. */
  endsAt(step: string | number): boolean {
    return (this.child(step)?.ends.length ?? 0) > 0;
  }

  *entries(): Generator<Entry> {
    yield* this.ends;
    for (const child of this.children.values()) yield* child.entries();
  }
}

/** A node the marks reach, and whether the marks that may be so under every item no longer reach below it. */
interface Source {
  readonly node: Node;
  readonly noMaybe: boolean;
}

/**
 * Sensitive marks held by their steps, so what is under a step is found without going over the marks of every other.
 * Reads as the paths it was given, in their order.
 */
export class Marks {
  private known: AttributePath[] | undefined;

  private constructor(
    private readonly sources: readonly Source[],
    private readonly depth: number,
    /** Gone under a step, so a path that said that step is exact has nothing left to say. */
    private readonly derived: boolean,
    /** The whole may be sensitive, as the value it is in may be. */
    private readonly maybeWhole: boolean
  ) {}

  static of(paths: readonly AttributePath[]): Marks {
    const root = new Node();
    for (const [seq, path] of paths.entries()) {
      let node = root;
      for (const step of path) {
        const key = stepKey(step);
        const next = node.children.get(key) ?? new Node();
        node.children.set(key, next);
        node = next;
      }
      node.ends.push({ seq, path });
    }

    return new Marks([{ node: root, noMaybe: false }], 0, false, false);
  }

  /**
   * What is left of each path after `step`. A value sensitive as a whole is so in every part.
   * One that may be so as a whole may be in every part.
   */
  under(step: string | number): Marks {
    if (this.sources.some(({ node }) => node.ends.length > 0)) return Marks.of([[]]);

    const exact = !isMarker(step) && this.sources.some(({ node }) => node.named(step)?.endsAt(EXACT) === true);
    const next = this.sources.flatMap(({ node, noMaybe }): Source[] => {
      const named = node.named(step);
      const everyItem = node.child(EVERY_ITEM);
      return [...(named ? [{ node: named, noMaybe }] : []), ...(everyItem ? [{ node: everyItem, noMaybe: noMaybe || exact }] : [])];
    });
    const maybeWhole = this.maybeWhole || this.sources.some(({ node, noMaybe }) => !noMaybe && node.endsAt(MAYBE));

    return new Marks(next, this.depth + 1, true, maybeWhole);
  }

  paths(): AttributePath[] {
    this.known ??= this.read();
    return this.known;
  }

  private read(): AttributePath[] {
    const kept = this.sources.flatMap(({ node, noMaybe }) => [...node.entries()].filter(({ path }) => !(noMaybe && isMaybe(path))));
    const left = kept
      .sort((one, other) => one.seq - other.seq)
      .map(({ path }) => path.slice(this.depth))
      .filter((path) => !(this.derived && path.length === 1 && path[0] === EXACT));

    return this.maybeWhole ? [...left, [MAYBE]] : left;
  }
}
