import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createStaticServer, listen, ROOT, RESOURCES } from './server.js';
import { findBrowser } from './browser-path.js';

class CDP {
  constructor(child) {
    this.nextId = 0; this.pending = new Map(); this.events = []; this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', data => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
        if (message.id) {
          const item = this.pending.get(message.id);
          if (item) {
            this.pending.delete(message.id);
            if (message.error) item.reject(new Error(JSON.stringify(message.error)));
            else item.resolve(message.result);
          }
        } else this.events.push(message);
      }
    });
    this.input = child.stdio[3];
    this.input.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`Chrome exited ${code ?? signal}`)));
  }
  fail(error) { this.error = error; for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  send(method, params = {}, sessionId) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
}

// Navigation must run outside Runtime.evaluate: page promises do not survive it.
async function testHistoryRestore(cdp, sessionId, url) {
  let assertions = 0;
  const ok = (condition, message) => { assert.ok(condition, message); assertions++; };
  const evaluate = async expression => {
    const value = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    assert.ok(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; }
      catch { /* A navigation can briefly destroy the execution context. */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`History restoration condition timeout: ${expression}`);
  };
  await evaluate(`(() => {
    const $ = selector => document.querySelector(selector);
    const mode = $('input[name="mode"][value="file"]'); mode.checked = true; mode.dispatchEvent(new Event('change'));
    for (const [side, content] of [['left', 'before'], ['right', 'after']]) {
      const transfer = new DataTransfer(); transfer.items.add(new File([content], 'history.txt'));
      const input = $('#' + side + '-file'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    }
    $('#path-filter').value = 'needle';
    window.__historyMarker = 'retained'; window.__historyRestores = 0;
    addEventListener('pageshow', event => { if (event.persisted) window.__historyRestores++; });
  })()`);
  const history = await cdp.send('Page.getNavigationHistory', {}, sessionId);
  const entryId = history.entries[history.currentIndex].id;
  for (let cycle = 1; cycle <= 2; cycle++) {
    await evaluate(`document.querySelector('#compare').click()`);
    await cdp.send('Page.navigate', { url: `${url}/?history-test=${cycle}` }, sessionId);
    await waitFor(`location.search === '?history-test=${cycle}' && document.documentElement.dataset.ready === 'true'`);
    await cdp.send('Page.navigateToHistoryEntry', { entryId }, sessionId);
    await waitFor(`location.search === '' && window.__historyMarker === 'retained' && window.__historyRestores === ${cycle}`);
    ok(await evaluate(`window.__historyRestores === ${cycle}`), 'actual BFCache pageshow.persisted on repeated restoration');
    ok(await evaluate(`document.querySelector('#cancel').disabled && !document.querySelector('#self-test').disabled`), 'restored page has no stranded task');
    ok(await evaluate(`document.querySelector('#left-file').files[0]?.name === 'history.txt' && !document.querySelector('#compare').disabled`), 'cached file selection remains available');
    await evaluate(`document.querySelector('#self-test').click()`);
    await waitFor(`document.querySelector('#cancel').disabled`);
    ok(await evaluate(`document.querySelector('#status').textContent.includes('自检通过')`), 'restored Worker runs self-test');
    await evaluate(`document.querySelector('#compare').click()`);
    await waitFor(`document.querySelector('#cancel').disabled`);
    ok(await evaluate(`document.querySelector('#detail-status').textContent.includes('1 个差异区块') && document.querySelector('#diff-body').textContent.includes('before')`), 'restored Worker compares retained files');
    ok(await evaluate(`!document.querySelector('#ignore-whitespace').disabled && !document.querySelector('#ignore-eol').disabled`), 'rules usable after restore/self-test/compare');
  }
  return assertions;
}

async function main() {
  const timeout = Number(process.env.BROWSER_TEST_TIMEOUT_MS || 45000);
  assert.ok(Number.isInteger(timeout) && timeout >= 100 && timeout <= 120000, 'Invalid browser test timeout');
  const chrome = await findBrowser();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'local-compare-chrome-'));
  const requests = [];
  const server = createStaticServer({ onRequest: request => requests.push(request) });
  let child; let exited; let timer;
  try {
    const url = await listen(server);
    child = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-breakpad',
      '--disable-features=MediaRouter,OptimizationHints', '--no-proxy-server', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
    exited = new Promise(resolve => { child.once('close', resolve); });
    const cdp = new CDP(child);
    const exercise = async () => {
      const version = await cdp.send('Browser.getVersion');
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      const source = await readFile(path.join(ROOT, 'tests/browser.js'), 'utf8');
      const flags = { forceFail: process.env.BROWSER_TEST_FORCE_FAIL === '1', forceTimeout: process.env.BROWSER_TEST_FORCE_TIMEOUT === '1' };
      // DevTools-only injection: no test HTTP resource, no weakened production CSP.
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${source}\n return await runBrowserTests(${JSON.stringify(flags)}); })()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      const report = result.result.value;
      assert.equal(report?.status, 'PASS'); assert.ok(report.assertions >= 50);
      report.assertions += await testHistoryRestore(cdp, sessionId, url);
      const exceptions = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown');
      assert.equal(exceptions.length, 0, 'Uncaught page error');
      for (const event of cdp.events.filter(event => event.method === 'Network.requestWillBeSent')) {
        assert.ok(event.params.request.url.startsWith(url + '/'), `Unexpected page network request: ${event.params.request.url}`);
        assert.equal(event.params.request.method, 'GET');
      }
      for (const request of requests) {
        assert.equal(request.method, 'GET');
        assert.ok(request.url === '/' || request.url === '/favicon.ico' || /^\/\?history-test=[12]$/u.test(request.url) || RESOURCES.includes(request.url), `Non-resource request ${request.url}`);
      }
      console.log(`Worker progress: ${JSON.stringify(report.progress)}`);
      console.log(`PASS browser: ${version.product}; ${report.assertions} actual assertions; real page/modules/Worker/CSP/BFCache; ${requests.length} loopback GETs; no user files`);
    };
    await Promise.race([exercise(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Chrome test timeout after ${timeout}ms`)), timeout);
    })]).catch(error => { throw new Error(`${error.message}\nChrome diagnostics (tail):\n${diagnostics}`); });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) {
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(killTimer);
    }
    try { await new Promise(resolve => server.close(resolve)); }
    finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
