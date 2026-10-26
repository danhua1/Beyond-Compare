import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { assert, test, entry } from './harness.js';
import { compareDirectory } from '../src/core/bytes.js';
import { compareText } from '../src/core/diff.js';

const source = (await readFile(new URL('../src/workers/compare-worker.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gmu, '');
function setup(directory = compareDirectory) {
  const messages = [];
  const self = { postMessage: data => messages.push(data) };
  const context = vm.createContext({ self, compareDirectory: directory, compareText,
    AbortController, performance, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const send = (id, type = 'start') => self.onmessage({ data: { type, id, operation: 'directory',
    left: [], right: [] } });
  const drain = async () => { await vm.runInContext('tail', context); };
  return { messages, send, drain };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Worker merges 10000 small-file progress events and never posts after the terminal result', async () => {
  const entries = Array.from({ length: 10000 }, (_, i) => entry(`${i}`));
  const worker = setup((left, right, options) => compareDirectory(entries, [], options));
  const start = performance.now(); worker.send('many'); await worker.drain();
  const elapsed = performance.now() - start;
  const progress = worker.messages.filter(m => m.type === 'progress');
  const final = worker.messages.at(-1);
  assert.equal(final.type, 'result'); assert.equal(final.result.status, 'complete');
  assert.equal(final.result.counts['left-only'], 10000);
  assert.ok(progress.length <= Math.ceil(elapsed / 75) + 1);
  assert.ok(progress.length < 10000 / 10);
  const count = worker.messages.length; await wait(100);
  assert.equal(worker.messages.length, count);
});

test('Worker cancels pending progress and serializes replacement without old-job messages', async () => {
  const jobs = [];
  const worker = setup((left, right, options) => new Promise(resolve => {
    jobs.push({ options, resolve });
    options.onProgress({ completed: 1 }); options.onProgress({ completed: 2 });
  }));
  worker.send('old'); await Promise.resolve();
  // tail starts after catch/then microtasks.
  await Promise.resolve();
  assert.equal(jobs.length, 1);
  worker.send('old', 'cancel');
  assert.equal(jobs[0].options.signal.aborted, true);
  const count = worker.messages.length; await wait(100);
  assert.equal(worker.messages.length, count);
  worker.send('fresh'); assert.equal(jobs.length, 1);
  jobs[0].options.onProgress({ completed: 99 });
  jobs[0].resolve({ status: 'cancelled' });
  for (let i = 0; i < 10 && jobs.length < 2; i++) await Promise.resolve();
  assert.equal(jobs.length, 2);
  jobs[1].resolve({ status: 'complete' }); await worker.drain();
  assert.equal(worker.messages.at(-1).id, 'fresh');
  assert.equal(worker.messages.at(-1).type, 'result');
  assert.equal(worker.messages.filter(m => m.id === 'old').length, count);
  const finalCount = worker.messages.length; await wait(100);
  assert.equal(worker.messages.length, finalCount);
});

test('Worker cancellation and errors send terminal messages immediately, dropping queued progress', async () => {
  for (const fail of [false, true]) {
    let complete;
    const worker = setup((left, right, options) => new Promise((resolve, reject) => {
      options.onProgress({ completed: 1 }); options.onProgress({ completed: 2 });
      complete = () => fail ? reject(new Error('controlled')) : resolve({ status: 'cancelled', reason: 'cancelled' });
    }));
    worker.send('job'); await Promise.resolve(); await Promise.resolve();
    if (!fail) worker.send('job', 'cancel');
    complete(); await worker.drain();
    const final = worker.messages.at(-1);
    assert.equal(final.type, 'result'); assert.equal(final.result.status, fail ? 'error' : 'cancelled');
    const count = worker.messages.length; await wait(100);
    assert.equal(worker.messages.length, count);
  }
});


test('real core handover waits for cancelled reads and preserves global read concurrency', async () => {
  let calls = 0; let active = 0; let peak = 0; let reads = 0;
  let worker;
  const observe = { delay: 2, onRead() {
    reads++; peak = Math.max(peak, ++active);
    if (reads === 1) worker.send('fresh');
  }, onReadEnd() { active--; } };
  const files = Array.from({ length: 300 }, (_, i) => entry(`${i}`, 'x', observe));
  const next = [entry('next-a', 'a', observe), entry('next-b', 'b', observe)];
  worker = setup((left, right, options) => {
    const entries = calls++ === 0 ? files : next;
    return compareDirectory(entries, entries, options);
  });
  worker.send('old');
  // Replacement is enqueued while the old lane still holds its first read.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await worker.drain();
  assert.equal(calls, 2); assert.equal(active, 0); assert.equal(peak, 2);
  assert.equal(reads, 5); // One old read plus both sides of two new files.
  const final = worker.messages.at(-1);
  assert.equal(final.id, 'fresh'); assert.equal(final.result.counts.same, 2);
  assert.equal(worker.messages.filter(message => message.id === 'old').length, 0);
});
