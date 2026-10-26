import { budget, cancelled, turn, LIMITS } from './limits.js';
import { readChunk } from './bytes.js';

export function decodeText(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > budget(options, 'textBytes')) return { status: 'uncompared', reason: 'text-limit' };
  let encoding = 'utf-8';
  let bomBytes = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bomBytes = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bomBytes = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bomBytes = 2; }
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bomBytes));
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      return { status: 'unsupported', reason: 'binary' };
    }
    return { status: 'ok', text, encoding, bomBytes };
  } catch {
    return { status: 'unsupported', reason: 'invalid-encoding' };
  }
}

export async function readText(file, options = {}) {
  if (cancelled(options.signal)) return { status: 'uncompared', reason: 'cancelled' };
  if (file.size > budget(options, 'textBytes')) return { status: 'uncompared', reason: 'text-limit' };
  try {
    const bytes = new Uint8Array(file.size);
    for (let start = 0; start < file.size; start += LIMITS.chunkBytes) {
      if (cancelled(options.signal)) return { status: 'uncompared', reason: 'cancelled' };
      bytes.set(await readChunk(file, start, Math.min(file.size, start + LIMITS.chunkBytes)), start);
      await turn();
    }
    return cancelled(options.signal) ? { status: 'uncompared', reason: 'cancelled' } : decodeText(bytes, options);
  } catch {
    return { status: cancelled(options.signal) ? 'uncompared' : 'error',
      reason: cancelled(options.signal) ? 'cancelled' : 'read-failed' };
  }
}

export function splitLines(text, options = {}) {
  const lines = [];
  const re = /\r\n|\r|\n/gu;
  let start = 0;
  let match;
  const add = (end, eol) => {
    lines.push({ number: lines.length + 1, start, end: end + eol.length,
      text: text.slice(start, end), eol, raw: text.slice(start, end + eol.length) });
    start = end + eol.length;
  };
  while ((match = re.exec(text))) {
    add(match.index, match[0]);
    if (lines.length > budget(options, 'lines')) return { status: 'uncompared', reason: 'line-limit' };
  }
  if (start < text.length) add(text.length, '');
  if (lines.length > budget(options, 'lines')) return { status: 'uncompared', reason: 'line-limit' };
  return { status: 'ok', lines };
}
