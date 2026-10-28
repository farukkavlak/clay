import { Graph } from '@clay/graph';
import { describe, expect, it } from 'vitest';

import { Reach, Step, walkTogether } from '../../src/run/walkTogether';

type Event = string;

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Each `[from, to]` an edge from a node to one that depends on it. */
function graphOf(nodes: string[], edges: [string, string][] = []): Graph<string> {
  const graph = new Graph<string>();
  for (const node of nodes) graph.addNode(node, node);
  for (const [from, to] of edges) graph.addEdge(from, to);
  return graph;
}

interface Plan {
  ms?: number;
  succeeds?: boolean;
  crashes?: boolean;
}

async function* stepping(steps: Steps, name: string, { ms = 5, succeeds = true, crashes = false }: Plan): AsyncGenerator<Event, boolean> {
  steps.running += 1;
  steps.most = Math.max(steps.most, steps.running);
  steps.log.push(`begin ${name}`);
  yield `start ${name}`;
  await pause(ms);
  steps.running -= 1;
  if (crashes) throw new Error(`${name} crashed`);
  steps.log.push(`finish ${name}`);
  yield succeeds ? `end ${name}` : `failed ${name}`;
  return succeeds;
}

/** Logs when each step begins and finishes and counts how many run at once. */
class Steps {
  readonly log: string[] = [];
  most = 0;
  running = 0;

  step(name: string, plan: Plan = {}): Step<Event> {
    return () => stepping(this, name, plan);
  }
}

/** Each node reached runs the steps `stepsOf` gives it, one named after the node where it gives none. */
function reaching(steps: Steps, stepsOf: Record<string, Step<Event>[] | false> = {}, crashes: string[] = []): Reach<Event> {
  return async function* (id) {
    steps.log.push(`reach ${id}`);
    yield `reached ${id}`;
    if (crashes.includes(id)) throw new Error(`${id} cannot be reached`);
    return Object.hasOwn(stepsOf, id) ? stepsOf[id] : [steps.step(id)];
  };
}

const failed = (event: Event) => event.startsWith('failed');

function walkOf(graph: Graph<string>, reach: Reach<Event>, limit = 10): AsyncGenerator<Event, boolean> {
  return walkTogether(graph.topologicalSort().flat(), graph, reach, limit, failed);
}

async function collect(run: AsyncGenerator<Event, boolean>): Promise<{ events: Event[]; result: boolean }> {
  const events: Event[] = [];
  while (true) {
    const step = await run.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

/** How long a walk takes over `size` nodes that depend on nothing and run no steps. */
async function wide(size: number): Promise<number> {
  const ids = Array.from({ length: size }, (_, index) => `n${index}`);
  const started = performance.now();
  await collect(walkOf(graphOf(ids), reaching(new Steps(), Object.fromEntries(ids.map((id) => [id, []])))));
  return performance.now() - started;
}

describe('walking a graph together', () => {
  it('reaches each node after every step of each node it depends on', async () => {
    const steps = new Steps();
    const graph = graphOf(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ]
    );

    const { result } = await collect(walkOf(graph, reaching(steps, { b: [steps.step('b1', { ms: 10 }), steps.step('b2')] })));

    expect(result).toBe(true);
    expect(steps.log.indexOf('reach b')).toBeGreaterThan(steps.log.indexOf('finish a'));
    expect(steps.log.indexOf('reach d')).toBeGreaterThan(Math.max(steps.log.indexOf('finish b1'), steps.log.indexOf('finish b2'), steps.log.indexOf('finish c')));
  });

  it('runs the steps of every node up to the limit at once', async () => {
    const steps = new Steps();
    const graph = graphOf(['a', 'b']);

    await collect(walkOf(graph, reaching(steps, { a: [steps.step('a1'), steps.step('a2')], b: [steps.step('b1'), steps.step('b2')] }), 3));

    expect(steps.most).toBe(3);
  });

  it('reaches a node once what it depends on is done, not once all beside that are', async () => {
    const steps = new Steps();
    const graph = graphOf(['slow', 'quick', 'after'], [['quick', 'after']]);

    await collect(walkOf(graph, reaching(steps, { slow: [steps.step('slow', { ms: 30 })] })));

    expect(steps.log.indexOf('finish after')).toBeLessThan(steps.log.indexOf('finish slow'));
  });

  it('gives events as they come, not a node at a time', async () => {
    const steps = new Steps();
    const graph = graphOf(['slow', 'quick']);

    const { events } = await collect(walkOf(graph, reaching(steps, { slow: [steps.step('slow', { ms: 30 })], quick: [steps.step('quick', { ms: 1 })] })));

    expect(events).toEqual(['reached slow', 'reached quick', 'start slow', 'start quick', 'end quick', 'end slow']);
  });

  it('runs nothing that depends on a failed step, through any others, and goes on beside it', async () => {
    const steps = new Steps();
    const graph = graphOf(
      ['bad', 'reader', 'further', 'beside', 'after'],
      [
        ['bad', 'reader'],
        ['reader', 'further'],
        ['beside', 'after'],
      ]
    );

    const { result } = await collect(walkOf(graph, reaching(steps, { bad: [steps.step('bad', { succeeds: false })] })));

    expect(result).toBe(false);
    expect(steps.log).not.toContain('reach reader');
    expect(steps.log).not.toContain('reach further');
    expect(steps.log).toContain('finish after');
  });

  it('runs the other steps of a node one of whose steps fails', async () => {
    const steps = new Steps();
    const graph = graphOf(['a']);

    const { result } = await collect(walkOf(graph, reaching(steps, { a: [steps.step('bad', { succeeds: false }), steps.step('other', { ms: 10 })] }), 1));

    expect(result).toBe(false);
    expect(steps.log).toContain('finish other');
  });

  it('runs nothing that depends on a node that cannot go on', async () => {
    const steps = new Steps();
    const graph = graphOf(['stopped', 'reader', 'beside'], [['stopped', 'reader']]);

    const { result } = await collect(walkOf(graph, reaching(steps, { stopped: false })));

    expect(result).toBe(false);
    expect(steps.log).not.toContain('reach reader');
    expect(steps.log).toContain('finish beside');
  });

  it('runs a node that depends on one that gives no steps', async () => {
    const steps = new Steps();
    const graph = graphOf(['value', 'reader'], [['value', 'reader']]);

    const { result } = await collect(walkOf(graph, reaching(steps, { value: [] })));

    expect(result).toBe(true);
    expect(steps.log).toContain('finish reader');
  });

  it('gives a deferred event only when nothing is running', async () => {
    const steps = new Steps();
    const graph = graphOf(['bad', 'slow']);

    const { events } = await collect(walkOf(graph, reaching(steps, { bad: [steps.step('bad', { ms: 1, succeeds: false })], slow: [steps.step('slow', { ms: 20 })] })));

    expect(events.slice(-2)).toEqual(['end slow', 'failed bad']);
  });

  it('starts nothing once a step throws, lets the running ones finish, then throws', async () => {
    const steps = new Steps();
    const graph = graphOf(['boom', 'slow', 'after'], [['slow', 'after']]);

    const walk = walkOf(graph, reaching(steps, { boom: [steps.step('boom', { ms: 1, crashes: true })], slow: [steps.step('slow', { ms: 20 })] }));

    await expect(collect(walk)).rejects.toThrow('boom crashed');
    expect(steps.log).toContain('finish slow');
    expect(steps.log).not.toContain('reach after');
  });

  // `broken` is reached once `first` runs, while `slow` runs.
  it('starts no step once a node cannot be reached', async () => {
    const steps = new Steps();
    const graph = graphOf(
      ['slow', 'first', 'broken', 'after'],
      [
        ['first', 'broken'],
        ['slow', 'after'],
      ]
    );

    await expect(collect(walkOf(graph, reaching(steps, { slow: [steps.step('slow', { ms: 20 })] }, ['broken'])))).rejects.toThrow('broken cannot be reached');
    expect(steps.log).toContain('finish slow');
    expect(steps.log).not.toContain('reach after');
  });

  // `late` is ready at the start but takes longer to reach than `quick` takes to give its step.
  it('starts no step until every node ready at the start is reached', async () => {
    const steps = new Steps();
    const graph = graphOf(['quick', 'late']);
    const reach: Reach<Event> = async function* (id) {
      yield `reached ${id}`;
      if (id === 'late') {
        await pause(20);
        throw new Error('late cannot be reached');
      }
      return [steps.step(id)];
    };

    await expect(collect(walkOf(graph, reach))).rejects.toThrow('late cannot be reached');
    expect(steps.log).not.toContain('begin quick');
  });

  // Room comes once `slow` ends, after `boom` has thrown.
  it('starts no step waiting for room once a step throws', async () => {
    const steps = new Steps();
    const graph = graphOf(['a']);
    const walk = walkOf(graph, reaching(steps, { a: [steps.step('boom', { ms: 1, crashes: true }), steps.step('slow', { ms: 20 }), steps.step('waiting')] }), 2);

    await expect(collect(walk)).rejects.toThrow('boom crashed');
    expect(steps.log).not.toContain('begin waiting');
  });

  // `a` gives `c` its edge first, so a walk that reached them as their edges come would reach `c` first.
  it('reaches the nodes ready together in the order', async () => {
    const steps = new Steps();
    const graph = graphOf(
      ['a', 'b', 'c'],
      [
        ['a', 'c'],
        ['a', 'b'],
      ]
    );
    const order = ['a', 'b', 'c'];

    await collect(walkTogether(order, graph, reaching(steps, { a: [], b: [], c: [] }), 10, failed));

    expect(steps.log).toEqual(['reach a', 'reach b', 'reach c']);
  });

  // `a` throws last, so a walk that threw the first throw to come would name `b`.
  it('throws the first throw in the order, not the first to come', async () => {
    const steps = new Steps();
    const graph = graphOf(['a', 'b']);

    const walk = walkOf(graph, reaching(steps, { a: [steps.step('a', { ms: 20, crashes: true })], b: [steps.step('b', { ms: 1, crashes: true })] }));

    await expect(collect(walk)).rejects.toThrow('a crashed');
  });

  it('waits for the step that is working when its reader stops early', async () => {
    const steps = new Steps();
    const graph = graphOf(['a']);
    const walk = walkOf(graph, reaching(steps, { a: [steps.step('a', { ms: 20 })] }));

    // `a` is working after these; the walk waits to be asked for more.
    await walk.next();
    await walk.next();
    await walk.return(false);

    expect(steps.log).toEqual(['reach a', 'begin a', 'finish a']);
  });

  it('walks a chain of nodes too long to reach one from the last on the stack', async () => {
    const ids = Array.from({ length: 6000 }, (_, index) => `n${index}`);
    const graph = graphOf(
      ids,
      ids.slice(1).map((id, index): [string, string] => [ids[index], id])
    );

    const { result } = await collect(walkOf(graph, reaching(new Steps(), Object.fromEntries(ids.map((id) => [id, []])))));

    expect(result).toBe(true);
  });

  it('walks nodes ready together in time that grows with them', async () => {
    await wide(500);

    expect((await wide(8000)) / (await wide(2000))).toBeLessThan(8);
  });

  it('returns true for no nodes', async () => {
    expect(await collect(walkOf(graphOf([]), reaching(new Steps())))).toEqual({ events: [], result: true });
  });
});
