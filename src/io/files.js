import { LIMITS } from '../core/limits.js';
import { validPath } from '../core/paths.js';

// A FileList is converted only after user selection; no filesystem write API.
export function entriesFromFiles(files, { directory = false } = {}) {
  if (files.length > LIMITS.files) throw new Error('directory-limit');
  const entries = [];
  let root;
  for (const file of files) {
    let path = file.name;
    if (directory) {
      const relative = file.webkitRelativePath;
      if (!validPath(relative) || !relative.includes('/')) throw new Error('invalid-directory-path');
      const parts = relative.split('/');
      const selectedRoot = parts.shift();
      if (root !== undefined && root !== selectedRoot) throw new Error('multiple-directory-roots');
      root = selectedRoot;
      path = parts.join('/');
    }
    if (!validPath(path)) throw new Error('invalid-file-path');
    entries.push({ path, file });
  }
  return entries;
}
