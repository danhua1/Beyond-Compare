import assert from 'node:assert/strict';

export { assert };
const cases = [];
export function test(name, fn) { cases.push({ name, fn }); }
export async function run() {
  let failures = 0;
  for (const { name, fn } of cases) {
    let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${name}`)), 15000);
      })]);
      console.log(`PASS ${name}`);
    } catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack || error}`); }
    finally { clearTimeout(timer); }
  }
  console.log(`${cases.length - failures}/${cases.length} tests passed`);
  if (failures) process.exitCode = 1;
}

export function fixture(content = '', options = {}) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    name: options.name || 'fixture.txt',
    size: options.size ?? bytes.length,
    webkitRelativePath: options.path || '',
    slice(start, end) {
      options.onSlice?.(start, end);
      return { async arrayBuffer() {
        options.onRead?.();
        try {
          if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
          if (options.fail) throw new Error('controlled fixture failure');
          return bytes.slice(start, end).buffer;
        } finally { options.onReadEnd?.(); }
      } };
    },
  };
}
export const entry = (path, content = '', options = {}) => ({ path, file: fixture(content, options) });
