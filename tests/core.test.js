import { assert, test, fixture, entry } from './harness.js';
import { LIMITS, budget } from '../src/core/limits.js';
import { compareBytes, compareDirectory } from '../src/core/bytes.js';
import { validPath, pairEntries } from '../src/core/paths.js';
import { decodeText, readText, splitLines } from '../src/core/text.js';
import { diffLines, compareText } from '../src/core/diff.js';
import { entriesFromFiles } from '../src/io/files.js';
import { CompareClient } from '../src/io/compare-client.js';

const utf8 = s => new TextEncoder().encode(s);

test('relative pairing, empty/nested/Chinese paths, size and byte differences', async () => {
  const left = [entry('empty'), entry('子目录/同名.txt', '甲'), entry('a/same.txt', 'abc'),
    entry('b/same.txt', 'left'), entry('only-left'), entry('size', 'a')];
  const right = [entry('empty'), entry('子目录/同名.txt', '甲'), entry('a/same.txt', 'abd'),
    entry('b/same.txt', 'left'), entry('only-right'), entry('size', 'long')];
  const progress = [];
  const result = await compareDirectory(left, right, { onProgress: x => progress.push(x) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.counts, { 'left-only': 1, 'right-only': 1, different: 2, same: 3, uncompared: 0, error: 0 });
  assert.ok(progress.some(p => p.type === 'bytes'));
  assert.equal(progress.filter(p => p.type === 'files').at(-1).completed, 7);
  assert.deepEqual((await compareDirectory([], [])).rows, []);
  assert.equal((await compareBytes(fixture('abc'), fixture('abc'))).status, 'same');
});

test('invalid/duplicate paths fail, no silent normalization; malicious names are data', async () => {
  for (const path of ['', '../x', '/x', 'x//y', 'x/./y', 'a\\b', 'nul\0']) assert.equal(validPath(path), false);
  assert.equal(validPath('<img src=x onerror=alert(1)>.txt'), true);
  const result = await compareDirectory([entry('a'), entry('a'), entry('../bad'), entry('<img src=x>.txt')], []);
  assert.equal(result.counts.error, 2);
  assert.equal(result.counts['left-only'], 1);
  assert.equal(pairEntries([entry('A')], [entry('a')]).pairs.length, 2);
});

test('stream chunks <=1 MiB; last-byte difference; no full file read', async () => {
  const bytes = new Uint8Array(2 * LIMITS.chunkBytes + 7);
  const slices = [];
  const left = fixture(bytes, { onSlice: (a, b) => slices.push([a, b]) });
  const right = fixture(bytes);
  assert.equal((await compareBytes(left, right, { chunkBytes: 99 * LIMITS.chunkBytes })).status, 'same');
  assert.equal(slices.length, 3);
  assert.ok(slices.every(([a, b]) => b - a <= LIMITS.chunkBytes));
  const changed = bytes.slice(); changed[changed.length - 1] = 1;
  assert.equal((await compareBytes(left, fixture(changed))).status, 'different');
});

test('maximum two lanes/reads even if caller asks for more', async () => {
  let active = 0; let peak = 0;
  const options = { delay: 2, onRead: () => { peak = Math.max(peak, ++active); }, onReadEnd: () => active-- };
  const entries = Array.from({ length: 12 }, (_, i) => entry(`${i}`, 'x', options));
  const result = await compareDirectory(entries, entries, { concurrency: 90 });
  assert.equal(result.counts.same, 12); assert.equal(peak, 2); assert.equal(active, 0);
});

test('50 MiB boundary is read fully, larger files never read or marked same', async () => {
  let read = 0;
  const large = { size: LIMITS.fileBytes, slice(start, end) {
    assert.ok(end - start <= LIMITS.chunkBytes);
    return { async arrayBuffer() { read++; return new ArrayBuffer(end - start); } };
  } };
  assert.equal((await compareBytes(large, large)).status, 'same');
  assert.equal(read, 100);
  const over = { ...large, size: LIMITS.fileBytes + 1 };
  assert.deepEqual(await compareBytes(over, over), { status: 'uncompared', reason: 'file-limit' });
  assert.equal(read, 100);
  const result = await compareDirectory([{ path: 'large', file: over }], []);
  assert.equal(result.rows[0].status, 'uncompared');
});

test('directory ceiling is per side; reject oversize before pairing or reading', async () => {
  const entries = Array.from({ length: LIMITS.files }, (_, i) => entry(`目录/${i}`));
  const exact = await compareDirectory(entries, entries);
  assert.equal(exact.status, 'complete'); assert.equal(exact.counts.same, 20000);
  const over = { length: LIMITS.files + 1, [Symbol.iterator]() { throw new Error('must not pair'); } };
  for (const sides of [[over, []], [[], over]]) {
    const result = await compareDirectory(...sides);
    assert.equal(result.status, 'limited'); assert.equal(result.reason, 'directory-limit');
    assert.equal(result.rows.length, 0); assert.equal(result.counts.same, 0);
  }
  const union = await compareDirectory([entry('a')], [entry('b')], { files: 1 });
  assert.equal(union.status, 'complete'); assert.equal(union.counts['left-only'], 1);
  assert.equal(union.counts['right-only'], 1);
  const left = Array.from({ length: 10001 }, (_, i) => entry(`left/${i}`));
  const right = Array.from({ length: 10001 }, (_, i) => entry(`right/${i}`));
  const disjoint = await compareDirectory(left, right);
  assert.equal(disjoint.status, 'complete'); assert.equal(disjoint.rows.length, 20002);
  assert.equal(disjoint.counts['left-only'], 10001); assert.equal(disjoint.counts['right-only'], 10001);
});

test('selection ceiling rejects before iteration, accepts exactly 20000, never truncates', () => {
  const over = { length: LIMITS.files + 1, [Symbol.iterator]() { throw new Error('must not convert'); } };
  assert.throws(() => entriesFromFiles(over, { directory: true }), /directory-limit/u);
  const files = Array.from({ length: LIMITS.files }, (_, i) => fixture('', { name: `${i}`, path: `root/${i}` }));
  assert.equal(entriesFromFiles(files, { directory: true }).length, LIMITS.files);
});

test('read failures, short reads, cancellations are never same', async () => {
  assert.equal((await compareBytes(fixture('abc', { fail: true }), fixture('abc'))).status, 'error');
  assert.equal((await compareBytes(fixture('', { size: 2 }), fixture('xx'))).reason, 'read-failed');
  const controller = new AbortController();
  const slow = fixture('x', { onReadEnd: () => controller.abort() });
  assert.deepEqual(await compareBytes(slow, fixture('x'), { signal: controller.signal }), { status: 'uncompared', reason: 'cancelled' });
  const cancelled = await compareDirectory([entry('x')], [entry('x')], { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.counts.same, 0);
  assert.equal(cancelled.rows[0].reason, 'cancelled');
  const c = new AbortController();
  const many = Array.from({ length: 300 }, (_, i) => entry(`${i}`));
  const result = await compareDirectory(many, many, { signal: c.signal,
    onProgress: p => { if (p.type === 'files' && p.completed === 2) c.abort(); } });
  assert.equal(result.rows.length, 300); assert.ok(result.counts.uncompared >= 298);
});

test('strict UTF-8/BOM and UTF-16LE/BE; binary and invalid encoding', () => {
  assert.equal(decodeText(utf8('中文\r\n')).text, '中文\r\n');
  const bom = decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('中文')]));
  assert.equal(bom.text, '中文'); assert.equal(bom.bomBytes, 3);
  for (const [bytes, encoding] of [[[0xff, 0xfe, 0x2d, 0x4e, 13, 0, 10, 0], 'utf-16le'],
    [[0xfe, 0xff, 0x4e, 0x2d, 0, 13, 0, 10], 'utf-16be']]) {
    const result = decodeText(Uint8Array.from(bytes));
    assert.equal(result.text, '中\r\n'); assert.equal(result.encoding, encoding);
  }
  for (const bytes of [[0xc3, 0x28], [0xc0, 0xaf], [0xff, 0xfe, 0], [0xff, 0xfe, 0, 0xd8], [0xfe, 0xff, 0xd8, 0]]) {
    assert.equal(decodeText(Uint8Array.from(bytes)).reason, 'invalid-encoding');
  }
  for (const bytes of [[0, 65], [0xff, 0xfe, 0, 0], [1, 2, 3]]) assert.equal(decodeText(Uint8Array.from(bytes)).reason, 'binary');
});

test('readText bounded/error/cancel, BOM preserved as metadata', async () => {
  assert.equal((await readText(fixture('ok'))).text, 'ok');
  assert.equal((await readText(fixture('x', { fail: true }))).reason, 'read-failed');
  assert.equal((await readText(fixture('', { size: LIMITS.textBytes + 1 }))).reason, 'text-limit');
  const controller = new AbortController(); controller.abort();
  assert.equal((await readText(fixture('x'), { signal: controller.signal })).reason, 'cancelled');
  const bytes = new Uint8Array(LIMITS.textBytes).fill(65);
  assert.equal(decodeText(bytes).status, 'ok');
  assert.equal(decodeText(new Uint8Array(LIMITS.textBytes + 1)).reason, 'text-limit');
  assert.equal((await readText(fixture(bytes))).text.length, LIMITS.textBytes);
});

const rebuild = (diff, side) => diff.rows.map(row => row[side]?.raw || '').join('');
function mapping(diff, side, original) {
  assert.equal(rebuild(diff, side), original);
  const lines = diff.rows.flatMap(row => row[side] ? [row[side]] : []);
  assert.equal(new Set(lines.map(l => l.number)).size, lines.length);
  let end = 0;
  for (const line of lines) { assert.equal(line.start, end); assert.equal(original.slice(line.start, line.end), line.raw); end = line.end; }
  assert.equal(end, original.length);
}

test('line diff insert/delete/replace/empty lines/final newline, exact raw mappings', async () => {
  const cases = [['', 'a\n', 'insert'], ['a\n', '', 'delete'], ['a', 'b', 'replace'],
    ['a\n\nb', 'a\nX\nb', 'replace'], ['a', 'a\n', 'replace'], ['\n', '', 'delete'],
    ['a\r\nb\rc\n', 'a\nb\rc\n', 'replace']];
  for (const [a, b, kind] of cases) {
    const diff = await diffLines(a, b);
    assert.equal(diff.status, 'ok'); assert.ok(diff.rows.some(row => row.kind === kind));
    mapping(diff, 'left', a); mapping(diff, 'right', b); assert.ok(diff.hunks.length > 0);
  }
  const empty = await diffLines('', '');
  assert.equal(empty.rows.length, 0); assert.equal(empty.differenceCount, 0);
  assert.equal(splitLines('a\r\n\r\nb\r').lines.map(l => l.raw).join(''), 'a\r\n\r\nb\r');
});

test('ignore rules retain originals and never alter byte status', async () => {
  const a = 'a b\r\n\t c\r'; const b = 'ab\n c\n';
  const strict = await diffLines(a, b); assert.ok(strict.differenceCount > 0);
  const ignored = await diffLines(a, b, { ignoreWhitespace: true, ignoreEol: true });
  assert.equal(ignored.differenceCount, 0); mapping(ignored, 'left', a); mapping(ignored, 'right', b);
  assert.equal((await compareBytes(fixture(a), fixture(b))).status, 'different');
  assert.ok((await diffLines('a', 'a\n', { ignoreEol: true })).differenceCount === 0);
  assert.ok((await diffLines('a\n', 'a\n\n', { ignoreEol: true })).differenceCount > 0);
});

test('seeded diff reconstruction and LCS minimality property (160 cases)', async () => {
  let seed = 4123;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
  for (let t = 0; t < 160; t++) {
    const make = () => Array.from({ length: random() % 10 }, () => `${['a', 'b', '', '中'][random() % 4]}${random() % 2 ? '\n' : '\r\n'}`).join('');
    const a = make(); const b = make();
    const diff = await diffLines(a, b);
    assert.equal(diff.status, 'ok'); mapping(diff, 'left', a); mapping(diff, 'right', b);
    const aa = splitLines(a).lines.map(l => l.raw); const bb = splitLines(b).lines.map(l => l.raw);
    const dp = Array.from({ length: aa.length + 1 }, () => new Array(bb.length + 1).fill(0));
    for (let i = 1; i <= aa.length; i++) for (let j = 1; j <= bb.length; j++) {
      dp[i][j] = aa[i - 1] === bb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
    assert.equal(diff.rows.filter(r => r.kind === 'equal').length, dp[aa.length][bb.length]);
  }
});

test('text bytes/20000 lines/work ceilings; worst-case diff exits without partial rows', async () => {
  assert.equal(splitLines('x\n'.repeat(20000)).status, 'ok');
  assert.equal(splitLines('x\n'.repeat(20001)).reason, 'line-limit');
  assert.equal((await diffLines('x\n'.repeat(20001), '')).reason, 'line-limit');
  assert.equal((await diffLines('x'.repeat(LIMITS.textBytes + 1), '')).reason, 'text-limit');
  const exact = await diffLines('x\n'.repeat(20000), 'x\n'.repeat(20000));
  assert.equal(exact.status, 'ok'); assert.equal(exact.rows.length, 20000);
  const limited = await diffLines('a\n'.repeat(2000), 'b\n'.repeat(2000));
  assert.equal(limited.reason, 'diff-budget'); assert.equal(limited.rows, undefined);
  const c = new AbortController();
  const running = diffLines('a\n'.repeat(1000), 'b\n'.repeat(1000), { signal: c.signal });
  setTimeout(() => c.abort(), 0);
  assert.equal((await running).reason, 'cancelled');
  assert.equal((await diffLines('x', 'y', { diffWork: 0 })).reason, 'diff-budget');
  assert.equal(budget({ files: 99999 }, 'files'), 20000);
});

test('text comparison exposes per-side status, single side and supported encodings', async () => {
  const one = await compareText(null, fixture('a\n'));
  assert.equal(one.rows[0].kind, 'insert');
  const bom = await compareText(fixture(Uint8Array.from([0xff, 0xfe, 65, 0])), fixture('A'));
  assert.equal(bom.differenceCount, 0); assert.equal(bom.left.encoding, 'utf-16le');
  const binary = await compareText(fixture(Uint8Array.from([0])), fixture('a'));
  assert.equal(binary.status, 'uncompared'); assert.equal(binary.left.reason, 'binary');
});

test('text comparison reads both bounded sides concurrently', async () => {
  let active = 0; let peak = 0;
  const observe = { delay: 2, onRead: () => { peak = Math.max(peak, ++active); }, onReadEnd: () => active-- };
  const result = await compareText(fixture('left', observe), fixture('right', observe));
  assert.equal(result.status, 'ok');
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('FileList adapter strips only selected root and rejects malformed roots', () => {
  const files = [fixture('', { name: 'a', path: '根/子/a' }), fixture('', { name: 'b', path: '根/b' })];
  assert.deepEqual(entriesFromFiles(files, { directory: true }).map(e => e.path), ['子/a', 'b']);
  assert.equal(entriesFromFiles([fixture('', { name: '<img>.txt' })])[0].path, '<img>.txt');
  assert.throws(() => entriesFromFiles([fixture('', { path: 'root/../x' })], { directory: true }));
  assert.throws(() => entriesFromFiles([fixture('', { path: 'r/a' }), fixture('', { path: 's/b' })], { directory: true }));
});

test('client stale-message isolation, progress, cancellation, errors and dispose', async () => {
  const sent = [];
  const worker = { postMessage: m => sent.push(m), terminate() { this.ended = true; } };
  const client = new CompareClient(worker);
  const old = client.start('directory', [], []);
  const oldId = sent.at(-1).id;
  let progress = 0;
  const next = client.start('directory', [], [], { onProgress: () => progress++ });
  const nextId = sent.at(-1).id;
  assert.equal((await old).status, 'cancelled');
  worker.onmessage({ data: { id: oldId, type: 'result', result: { status: 'same' } } });
  worker.onmessage({ data: { id: oldId, type: 'progress' } }); assert.equal(progress, 0);
  worker.onmessage({ data: { id: nextId, type: 'progress' } }); assert.equal(progress, 1);
  worker.onmessage({ data: { id: nextId, type: 'result', result: { status: 'complete' } } });
  assert.equal((await next).status, 'complete');
  const failing = client.start('text', null, null);
  worker.onerror({ preventDefault() {} }); assert.equal((await failing).reason, 'worker-failed');
  assert.equal(worker.ended, true); assert.equal((await client.start('text', null, null)).reason, 'worker-disposed');
});


test('large diff batches preserve mappings, budget boundary, progress and timed cancellation', async () => {
  const text = Array.from({ length: LIMITS.lines }, (_, i) => `line-${i}\n`).join('');
  for (const right of [text, text.replace('line-10000', 'changed-10000')]) {
    const diff = await diffLines(text, right);
    assert.equal(diff.status, 'ok'); mapping(diff, 'left', text); mapping(diff, 'right', right);
  }
  const progress = [];
  const a = 'left\n'.repeat(1000); const b = 'right\n'.repeat(1000);
  const limited = await diffLines(a, b, { onProgress: p => progress.push(p) });
  assert.equal(limited.reason, 'diff-budget'); assert.equal(limited.work, LIMITS.diffWork + 1);
  assert.equal(limited.rows, undefined); assert.ok(progress.length < 100);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    const cancelled = await diffLines(a, b, { signal: controller.signal });
    assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.rows, undefined);
  } finally { clearTimeout(timer); }
});

test('distant sparse edits finish exactly at 2000/20000 lines with original mappings and shared work budget', async () => {
  for (const count of [2000, 20000]) {
    const lines = Array.from({ length: count }, (_, i) => `line-${i}\r\n`);
    const changed = lines.slice(); changed[100] = 'changed-100\n'; changed[count - 100] = 'changed-last\n';
    const left = lines.join(''); const right = changed.join('');
    const diff = await diffLines(left, right);
    assert.equal(diff.status, 'ok'); assert.equal(diff.differenceCount, 2);
    assert.equal(diff.rows.filter(r => r.kind === 'equal').length, count - 2);
    assert.ok(diff.work < LIMITS.diffWork);
    mapping(diff, 'left', left); mapping(diff, 'right', right);
    assert.equal((await diffLines(left, right, { diffWork: diff.work })).status, 'ok');
    const limited = await diffLines(left, right, { diffWork: diff.work - 1 });
    assert.equal(limited.reason, 'diff-budget'); assert.equal(limited.work, diff.work);
    assert.equal(limited.rows, undefined);
  }
  const left = 'start\na b\nx\nx\nend\n'; const right = 'start\nab\r\nx\nnew\nx\nend\n';
  const diff = await diffLines(left, right, { ignoreWhitespace: true, ignoreEol: true });
  assert.equal(diff.differenceCount, 1); mapping(diff, 'left', left); mapping(diff, 'right', right);
});

test('sparse probe and Hirschberg fallback agree with independent optimal LCS on larger duplicate-heavy inputs', async () => {
  let seed = 123456;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const cases = [
    [Array(100).fill('a'), Array(100).fill('b')], // Edit distance > 64: bounded probe falls back.
    [Array.from({ length: 120 }, (_, i) => `a${i}`), Array(10).fill('a0')], // Length gap skips probe.
  ];
  for (let i = 0; i < 30; i++) {
    const left = Array.from({ length: 90 + random(60) }, () => String(random(7)));
    const right = i % 2 ? Array.from({ length: 90 + random(60) }, () => String(random(7))) : left.slice();
    if (!(i % 2)) for (let j = 0; j < 12; j++) right.splice(random(right.length), random(2), 'edit');
    cases.push([left, right]);
  }
  for (const [left, right] of cases) {
    const prev = new Uint16Array(right.length + 1);
    for (const a of left) {
      let diagonal = 0;
      for (let j = 1; j <= right.length; j++) {
        const old = prev[j];
        prev[j] = a === right[j - 1] ? diagonal + 1 : Math.max(prev[j], prev[j - 1]);
        diagonal = old;
      }
    }
    const a = left.map(x => `${x}\n`).join(''); const b = right.map(x => `${x}\n`).join('');
    const diff = await diffLines(a, b);
    assert.equal(diff.status, 'ok');
    assert.equal(diff.rows.filter(row => row.kind === 'equal').length, prev[right.length]);
    assert.ok(diff.rows.filter(row => row.kind === 'equal').every(row => row.left.raw === row.right.raw));
    mapping(diff, 'left', a); mapping(diff, 'right', b);
  }
});

test('40000-path cancellation fills remaining rows without progress or reads, retaining invalid-path errors', async () => {
  let reads = 0;
  const make = prefix => Array.from({ length: LIMITS.files }, (_, i) => entry(`${prefix}/${i}`, 'x', { onRead: () => reads++ }));
  const left = make('left'); const right = make('right');
  const controller = new AbortController(); let progress = 0;
  const result = await compareDirectory(left, right, { signal: controller.signal, onProgress() {
    progress++; controller.abort();
  } });
  assert.equal(result.rows.length, 40000); assert.equal(result.status, 'cancelled');
  assert.equal(progress, 1); assert.equal(reads, 0);
  assert.equal(result.counts.uncompared, 39999);
  assert.equal(result.rows.filter(row => row.reason === 'cancelled').length, 39999);
  const invalid = await compareDirectory([entry('dup'), entry('dup'), entry('../bad'), entry('ok')], [], {
    signal: controller.signal, onProgress() { assert.fail('cancelled scans must not publish progress'); },
  });
  assert.equal(invalid.counts.error, 2); assert.equal(invalid.counts.uncompared, 1);
  assert.equal(invalid.rows.find(row => row.path === 'dup').reason, 'duplicate-path');
  const completed = await compareDirectory([entry('next', 'x')], [entry('next', 'x')]);
  assert.equal(completed.counts.same, 1);
});

test('edit-distance probe boundary at 64 and fallback at 66 preserve exact matching', async () => {
  const lines = Array.from({ length: 160 }, (_, i) => `line-${i}\n`);
  for (const edits of [32, 33]) {
    const changed = lines.slice();
    for (let i = 0; i < edits; i++) changed[Math.floor(i * 159 / (edits - 1))] = `change-${i}\n`;
    const diff = await diffLines(lines.join(''), changed.join(''));
    assert.equal(diff.status, 'ok');
    assert.equal(diff.rows.filter(row => row.kind === 'equal').length, 160 - edits);
    mapping(diff, 'left', lines.join('')); mapping(diff, 'right', changed.join(''));
  }
});
