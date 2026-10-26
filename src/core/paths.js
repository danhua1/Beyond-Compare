export function validPath(path) {
  return typeof path === 'string' && path.length > 0 &&
    !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}

// No normalization, case folding or basename matching: paths remain exact.
export function pairEntries(left, right) {
  const pairs = new Map();
  const errors = [];
  for (const [side, entries] of [['left', left], ['right', right]]) {
    for (const entry of entries) {
      if (!entry || !validPath(entry.path) || !entry.file ||
          !Number.isSafeInteger(entry.file.size) || entry.file.size < 0 ||
          typeof entry.file.slice !== 'function') {
        errors.push({ path: typeof entry?.path === 'string' ? entry.path : '',
          status: 'error', reason: 'invalid-entry', side });
        continue;
      }
      let pair = pairs.get(entry.path);
      if (!pair) {
        pair = { path: entry.path, left: null, right: null };
        pairs.set(entry.path, pair);
      }
      if (pair[side]) pair.invalid = true;
      else pair[side] = entry.file;
    }
  }
  return { pairs: Array.from(pairs.values()), errors };
}
