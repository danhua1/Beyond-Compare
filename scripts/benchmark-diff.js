import { performance } from 'node:perf_hooks';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional baseline core directory uses the same cases and measurement process.
const core = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2], 'diff.js')) : new URL('../src/core/diff.js', import.meta.url);
const { diffLines } = await import(new URL('diff.js', core));
const { compareDirectory } = await import(new URL('bytes.js', core));

const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n');
const base = lines('line-', 1000);
const near = lines('line-', 20000);
const cases = {
  identical: [near, near],
  sparse: [base, base.replace('line-500', 'changed-500')],
  different: [lines('left-', 1000), lines('right-', 1000)],
  repeated: ['a\nb\n'.repeat(150), 'b\na\n'.repeat(150)],
  'near-line-limit': [near, near.replace('line-10000', 'changed-10000')],
  'distant-2000': [lines('line-', 2000), lines('line-', 2000).replace('line-100\n', 'changed-a\n').replace('line-1900\n', 'changed-b\n')],
  'distant-20000': [near, near.replace('line-100\n', 'changed-a\n').replace('line-19900\n', 'changed-b\n')],
};
const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0].model }, samples: 3, cases: {} };
for (const [name, [left, right]] of Object.entries(cases)) {
  const runs = [];
  for (let i = 0; i < report.samples; i++) {
    let progress = 0;
    const start = performance.now();
    const result = await diffLines(left, right, { onProgress: () => progress++ });
    runs.push({ ms: +(performance.now() - start).toFixed(2), work: result.work,
      progress, status: result.status, reason: result.reason, differenceCount: result.differenceCount });
  }
  report.cases[name] = runs;
}
report.cancellation = [];
for (let i = 0; i < report.samples; i++) {
  const controller = new AbortController();
  const start = performance.now();
  let requested;
  const timer = setTimeout(() => { requested = performance.now(); controller.abort(); }, 5);
  const result = await diffLines(...cases.different, { signal: controller.signal });
  clearTimeout(timer);
  report.cancellation.push({ totalMs: +(performance.now() - start).toFixed(2),
    afterAbortMs: +(performance.now() - requested).toFixed(2), status: result.status, reason: result.reason });
}
report.directoryCancellation = [];
const emptyFile = { size: 0, slice() { throw new Error('Unexpected metadata-only read'); } };
const metadata = prefix => Array.from({ length: 20000 }, (_, i) => ({ path: `${prefix}/${i}`, file: emptyFile }));
const directoryLeft = metadata('left'); const directoryRight = metadata('right');
for (let i = 0; i < report.samples; i++) {
  const controller = new AbortController();
  let requested; let progress = 0;
  const start = performance.now();
  const result = await compareDirectory(directoryLeft, directoryRight, { signal: controller.signal, onProgress() {
    progress++;
    if (requested === undefined) { requested = performance.now(); controller.abort(); }
  } });
  assert.equal(result.status, 'cancelled'); assert.equal(result.rows.length, 40000);
  assert.equal(result.counts.uncompared, 39999); assert.equal(result.counts.error, 0);
  assert.ok(requested !== undefined);
  report.directoryCancellation.push({ totalMs: +(performance.now() - start).toFixed(2),
    afterAbortMs: +(performance.now() - requested).toFixed(2), progress,
    rows: result.rows.length, status: result.status, counts: result.counts });
}
console.log(JSON.stringify(report, null, 2));
