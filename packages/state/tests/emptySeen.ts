import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

// Reads in a thread of its own, so it can land between two steps of a write the test's thread is making.
const reader = `
const { readFileSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const stop = new Int32Array(workerData.stop);
let empty = 0;
parentPort.postMessage('reading');
while (Atomics.load(stop, 0) === 0) {
  try {
    if (readFileSync(workerData.target, 'utf8') === '') empty++;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
parentPort.postMessage(empty);
`;

/** How many times another thread found `target` there but empty while `writes` ran. */
export async function emptySeen(target: string, writes: () => Promise<void>): Promise<number> {
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(reader, { eval: true, workerData: { target, stop: stop.buffer } });
  await once(worker, 'message');

  try {
    await writes();
  } finally {
    Atomics.store(stop, 0, 1);
  }

  const [empty] = (await once(worker, 'message')) as [number];
  await worker.terminate();
  return empty;
}
