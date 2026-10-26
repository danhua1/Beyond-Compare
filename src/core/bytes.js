import { budget, LIMITS, cancelled, turn } from './limits.js';
import { pairEntries } from './paths.js';

const outcome = (status, reason) => reason ? { status, reason } : { status };

export async function readChunk(file, start, end) {
  const buffer = await file.slice(start, end).arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== end - start) {
    throw new Error('short-read');
  }
  return new Uint8Array(buffer);
}

export async function compareBytes(left, right, options = {}) {
  const { signal, onProgress = () => {} } = options;
  if (cancelled(signal)) return outcome('uncompared', 'cancelled');
  const max = budget(options, 'fileBytes');
  if (left.size > max || right.size > max) return outcome('uncompared', 'file-limit');
  if (left.size !== right.size) return outcome('different');
  const chunkSize = Math.max(1, budget(options, 'chunkBytes'));
  try {
    for (let offset = 0; offset < left.size; offset += chunkSize) {
      if (cancelled(signal)) return outcome('uncompared', 'cancelled');
      const end = Math.min(left.size, offset + chunkSize);
      // Sequential reads per lane: at most two reads in flight across the directory.
      const a = await readChunk(left, offset, end);
      if (cancelled(signal)) return outcome('uncompared', 'cancelled');
      const b = await readChunk(right, offset, end);
      if (cancelled(signal)) return outcome('uncompared', 'cancelled');
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return outcome('different');
      }
      onProgress({ bytes: end, totalBytes: left.size });
      await turn();
    }
    return cancelled(signal) ? outcome('uncompared', 'cancelled') : outcome('same');
  } catch {
    return outcome(cancelled(signal) ? 'uncompared' : 'error',
      cancelled(signal) ? 'cancelled' : 'read-failed');
  }
}

export async function compareDirectory(left, right, options = {}) {
  const { signal, onProgress = () => {} } = options;
  // Reject before pairing/allocation; the ceiling is per side, not the path union.
  if (Math.max(left.length, right.length) > budget(options, 'files')) {
    return { status: 'limited', reason: 'directory-limit', rows: [],
      counts: { 'left-only': 0, 'right-only': 0, different: 0, same: 0, uncompared: 0, error: 0 },
      limits: LIMITS };
  }
  const { pairs, errors } = pairEntries(left, right);
  const rows = new Array(pairs.length);
  let cursor = 0;
  let completed = 0;
  async function lane() {
    while (cursor < pairs.length) {
      if (cancelled(signal)) break;
      const index = cursor++;
      const pair = pairs[index];
      let result;
      if (pair.invalid) result = outcome('error', 'duplicate-path');
      else if (cancelled(signal)) result = outcome('uncompared', 'cancelled');
      else if ([pair.left, pair.right].some(f => f && f.size > budget(options, 'fileBytes'))) {
        result = outcome('uncompared', 'file-limit');
      } else if (!pair.left) result = outcome('right-only');
      else if (!pair.right) result = outcome('left-only');
      else result = await compareBytes(pair.left, pair.right, {
        ...options,
        onProgress: progress => onProgress({ type: 'bytes', path: pair.path, ...progress }),
      });
      if (cancelled(signal) && result.status === 'same') result = outcome('uncompared', 'cancelled');
      rows[index] = { path: pair.path, ...result };
      completed++;
      if (cancelled(signal)) break;
      onProgress({ type: 'files', completed, total: pairs.length + errors.length });
      // Even metadata-only scans yield, so cancel messages can be processed.
      if (!cancelled(signal) && completed % 128 === 0) await turn();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, budget(options, 'concurrency')) }, lane));
  // Preserve every path without running the cancelled remainder through async lanes.
  // Existing invalid paths remain errors, matching normal scan semantics.
  if (cancelled(signal)) {
    for (let i = 0; i < pairs.length; i++) {
      if (rows[i]) continue;
      rows[i] = { path: pairs[i].path, ...(pairs[i].invalid
        ? outcome('error', 'duplicate-path') : outcome('uncompared', 'cancelled')) };
    }
  }
  for (const error of errors) rows.push(error);
  const counts = { 'left-only': 0, 'right-only': 0, different: 0, same: 0, uncompared: 0, error: 0 };
  for (const row of rows) counts[row.status]++;
  return {
    status: cancelled(signal) ? 'cancelled' : counts.error ? 'error' :
      counts.uncompared ? 'limited' : 'complete',
    reason: cancelled(signal) ? 'cancelled' : undefined,
    rows, counts, limits: LIMITS,
  };
}
