import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, RESOURCES, CSP } from './server.js';

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(filename));
    else if (item.isFile()) files.push(filename);
    else throw new Error(`Non-regular source: ${filename}`);
  }
  return files;
}

async function check() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
  for (const script of ['start', 'check', 'test', 'test:browser']) assert.ok(pkg.scripts[script]);
  const files = (await Promise.all(['src', 'scripts', 'tests'].map(p => walk(path.join(ROOT, p))))).flat();
  const sources = files.filter(p => p.endsWith('.js'));
  let references = 0;
  for (const filename of sources) {
    const syntax = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const code = await readFile(filename, 'utf8');
    const production = filename.startsWith(path.join(ROOT, 'src') + path.sep);
    if (production) {
      assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|sendBeacon|showSaveFilePicker|showDirectoryPicker|createWritable)\b|serviceWorker|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|\beval\s*\(|new\s+Function\b/u.test(code), `Unsafe API: ${filename}`);
      assert.ok(!/\bconsole\s*\./u.test(code), `Production logging: ${filename}`);
      assert.ok(RESOURCES.includes('/' + path.relative(ROOT, filename).split(path.sep).join('/')), `Missing whitelist entry: ${filename}`);
    }
    const refs = [
      ...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/gu),
      ...code.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/gu),
      ...code.matchAll(/new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/gu),
    ];
    for (const [, reference] of refs) {
      if (!production && reference.startsWith('node:')) continue;
      assert.ok(reference.startsWith('.') || reference.startsWith('/src/'), `Nonlocal import ${reference}`);
      const target = reference.startsWith('/src/') ? path.join(ROOT, reference) : path.resolve(path.dirname(filename), reference);
      assert.ok(target === path.resolve(ROOT) || target.startsWith(ROOT), `Escaping import ${reference}`);
      const targetInfo = await stat(target);
      assert.ok(targetInfo.isFile() || (!production && reference === '../' && targetInfo.isDirectory()), `Missing module ${reference}`);
      if (production) assert.ok(RESOURCES.includes('/' + path.relative(ROOT, target).split(path.sep).join('/')));
      references++;
    }
  }
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/main\.js"><\/script>/u);
  assert.ok(!/\son\w+\s*=|javascript:|https?:\/\//iu.test(html));
  assert.ok(!/<style\b|\sstyle\s*=/iu.test(html));
  const metaCsp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/u)?.[1];
  assert.ok(metaCsp);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "worker-src 'self'", "script-src 'self'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(metaCsp.includes(directive)); assert.ok(CSP.includes(directive));
  }
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    assert.ok(RESOURCES.includes(reference), `Invalid HTML reference ${reference}`);
  }
  const css = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8');
  assert.ok(!/@import|url\s*\(/iu.test(css), 'CSS external resource');
  for (const resource of RESOURCES) {
    assert.ok(resource === '/index.html' || resource.startsWith('/src/'));
    assert.ok(!resource.split('/').some(p => p.startsWith('.')));
    assert.ok((await stat(path.join(ROOT, resource))).isFile());
  }
  console.log(`PASS check: ${sources.length} JS syntax checks, ${references} local module references, resources/CSP/privacy guards`);
}
check().catch(error => { console.error(error); process.exitCode = 1; });
