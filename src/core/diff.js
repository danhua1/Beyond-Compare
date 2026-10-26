import { budget, cancelled, turn } from './limits.js';
import { splitLines, readText } from './text.js';

// Bounded Myers probe for sparse edits, with linear-space Hirschberg fallback.
async function diffLinesWithinLimit(leftText, rightText, options = {}) {
  const a = splitLines(leftText, options);
  const b = splitLines(rightText, options);
  if (a.status !== 'ok') return a;
  if (b.status !== 'ok') return b;
  const key = line => (options.ignoreWhitespace ? line.text.replace(/[^\S\r\n]+/gu, '') : line.text) +
    (options.ignoreEol ? '' : line.eol);
  const left = a.lines.map(key);
  const right = b.lines.map(key);
  const maxWork = budget(options, 'diffWork');
  let work = 0;
  let lastYieldWork = 0;
  let lastYieldAt = performance.now();
  let lastProgressAt = lastYieldAt;
  // Budget accounting remains exact; most cells do not allocate a Promise.
  function tick() {
    work++;
    if (cancelled(options.signal)) throw 'cancelled';
    if (work > maxWork) throw 'diff-budget';
    return work % 2048 === 0 &&
      (work - lastYieldWork >= 32768 || performance.now() - lastYieldAt >= 8);
  }
  async function checkpoint() {
    const now = performance.now();
    if (now - lastProgressAt >= 75) {
      options.onProgress?.({ type: 'diff', work, maxWork });
      lastProgressAt = now;
    }
    await turn();
    lastYieldWork = work;
    lastYieldAt = performance.now();
    if (cancelled(options.signal)) throw 'cancelled';
  }
  async function scores(a0, a1, b0, b1, reverse) {
    const width = b1 - b0;
    let prev = new Uint32Array(width + 1);
    let curr = new Uint32Array(width + 1);
    for (let i = 0; i < a1 - a0; i++) {
      curr[0] = 0;
      const x = left[reverse ? a1 - 1 - i : a0 + i];
      for (let j = 1; j <= width; j++) {
        if (tick()) await checkpoint();
        curr[j] = x === right[reverse ? b1 - j : b0 + j - 1]
          ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
    }
    return prev;
  }
  async function midpoint(a0, mid, a1, b0, b1) {
    const forward = await scores(a0, mid, b0, b1, false);
    const backward = await scores(mid, a1, b0, b1, true);
    let best = -1;
    let at = 0;
    for (let i = 0; i <= b1 - b0; i++) {
      if (tick()) await checkpoint();
      const score = forward[i] + backward[b1 - b0 - i];
      if (score > best) { best = score; at = i; }
    }
    return b0 + at;
  }
  // Probe only once, with fixed bounds on both work and edit history. Every
  // operation also consumes the shared budget; unsuccessful probes fall back.
  async function sparseMatches(a0, a1, b0, b1) {
    const maxDistance = 64;
    const probeWork = 65536;
    const n = a1 - a0;
    const m = b1 - b0;
    if (Math.abs(n - m) > maxDistance) return null;
    const offset = maxDistance + 1;
    const frontier = new Int32Array(2 * maxDistance + 3).fill(-1);
    frontier[offset + 1] = 0;
    const trace = [];
    const started = work;
    for (let d = 0; d <= maxDistance; d++) {
      trace.push(frontier.slice());
      for (let k = -d; k <= d; k += 2) {
        if (work - started >= probeWork) return null;
        if (tick()) await checkpoint();
        let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
          ? frontier[offset + k + 1] : frontier[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m) {
          if (work - started >= probeWork) return null;
          if (tick()) await checkpoint();
          if (left[a0 + x] !== right[b0 + y]) break;
          x++; y++;
        }
        frontier[offset + k] = x;
        if (x < n || y < m) continue;
        const found = [];
        for (let depth = d; depth >= 0; depth--) {
          const previous = trace[depth];
          const diagonal = x - y;
          const previousK = diagonal === -depth ||
            (diagonal !== depth && previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
            ? diagonal + 1 : diagonal - 1;
          const previousX = previous[offset + previousK];
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            if (tick()) await checkpoint();
            found.push([a0 + --x, b0 + --y]);
          }
          x = previousX; y = previousY;
        }
        return found.reverse();
      }
    }
    return null;
  }
  const matches = [];
  async function lcs(a0, a1, b0, b1, probe = false) {
    while (a0 < a1 && b0 < b1 && left[a0] === right[b0]) {
      if (tick()) await checkpoint();
      matches.push([a0++, b0++]);
    }
    let suffix = 0;
    while (a0 < a1 - suffix && b0 < b1 - suffix &&
      left[a1 - 1 - suffix] === right[b1 - 1 - suffix]) {
      if (tick()) await checkpoint();
      suffix++;
    }
    const ae = a1 - suffix;
    const be = b1 - suffix;
    if (a0 < ae && b0 < be) {
      if (ae - a0 === 1) {
        for (let j = b0; j < be; j++) {
          if (tick()) await checkpoint();
          if (left[a0] === right[j]) { matches.push([a0, j]); break; }
        }
      } else {
        const sparse = probe ? await sparseMatches(a0, ae, b0, be) : null;
        if (sparse) {
          for (const match of sparse) matches.push(match);
        } else {
          const mid = Math.floor((a0 + ae) / 2);
          const split = await midpoint(a0, mid, ae, b0, be);
          await lcs(a0, mid, b0, split);
          await lcs(mid, ae, split, be);
        }
      }
    }
    for (let i = 0; i < suffix; i++) matches.push([ae + i, be + i]);
  }
  try {
    if (cancelled(options.signal)) return { status: 'uncompared', reason: 'cancelled' };
    await lcs(0, left.length, 0, right.length, true);
    const rows = [];
    let ai = 0;
    let bi = 0;
    const gap = (ae, be) => {
      while (ai < ae || bi < be) {
        const l = ai < ae ? a.lines[ai++] : null;
        const r = bi < be ? b.lines[bi++] : null;
        rows.push({ kind: l && r ? 'replace' : l ? 'delete' : 'insert', left: l, right: r });
      }
    };
    for (const [x, y] of matches) {
      gap(x, y);
      rows.push({ kind: 'equal', left: a.lines[ai++], right: b.lines[bi++] });
    }
    gap(left.length, right.length);
    const hunks = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'equal') continue;
      const start = i;
      while (i + 1 < rows.length && rows[i + 1].kind !== 'equal') i++;
      hunks.push({ index: hunks.length, start, end: i + 1 });
    }
    return { status: 'ok', rows, hunks, differenceCount: hunks.length, work,
      rules: { ignoreWhitespace: Boolean(options.ignoreWhitespace), ignoreEol: Boolean(options.ignoreEol) } };
  } catch (reason) {
    if (reason === 'cancelled' || reason === 'diff-budget') return { status: 'uncompared', reason, work };
    throw reason;
  }
}

export async function diffLines(leftText, rightText, options = {}) {
  const encoder = new TextEncoder();
  if (encoder.encode(leftText).length > budget(options, 'textBytes') ||
      encoder.encode(rightText).length > budget(options, 'textBytes')) {
    return { status: 'uncompared', reason: 'text-limit' };
  }
  return diffLinesWithinLimit(leftText, rightText, options);
}

export async function compareText(leftFile, rightFile, options = {}) {
  const empty = { status: 'ok', text: '', encoding: null, bomBytes: 0 };
  const [left, right] = await Promise.all([
    leftFile ? readText(leftFile, options) : empty,
    rightFile ? readText(rightFile, options) : empty,
  ]);
  if (left.status !== 'ok' || right.status !== 'ok') {
    return { status: 'uncompared', reason: left.status !== 'ok' ? left.reason : right.reason, left, right };
  }
  const diff = await diffLinesWithinLimit(left.text, right.text, options);
  return { ...diff, left, right };
}
