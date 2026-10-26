import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { assert, test, entry } from './harness.js';
import { CompareClient } from '../src/io/compare-client.js';
import { entriesFromFiles } from '../src/io/files.js';

const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gmu, '');
class Element {
  constructor() {
    this.textContent = ''; this.dataset = {}; this.children = []; this.listeners = {};
    this.disabled = false; this.hidden = false; this.value = ''; this.files = []; this.previousElementSibling = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn(); }
  click() { if (!this.disabled) this.dispatch('click'); }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  blur() {}
}
function setup() {
  const nodes = new Map();
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const modes = [new Element(), new Element()]; modes[0].value = 'file'; modes[1].value = 'directory';
  get('#status-filter').value = 'all';
  const workers = [];
  const timers = new Map(); let timerId = 0;
  const events = {};
  const createClient = () => {
    const worker = { messages: [], postMessage(data) { this.messages.push(data); }, terminate() { this.ended = true; } };
    workers.push(worker);
    return new CompareClient(worker);
  };
  const document = { querySelector: get, querySelectorAll: () => modes,
    createElement: () => new Element(), documentElement: { dataset: {} } };
  const context = vm.createContext({ document, CompareClient: class { constructor() { return createClient(); } },
    entriesFromFiles, window: { addEventListener(type, fn) { (events[type] ||= []).push(fn); } }, File: class {},
    setTimeout(fn, delay) { assert.equal(delay, 80); timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  const currentWorker = () => workers.at(-1);
  const latest = () => currentWorker().messages.filter(m => m.type === 'start').at(-1);
  const result = async (value, id = latest().id) => {
    currentWorker().onmessage({ data: { id, type: 'result', result: value } });
    await new Promise(resolve => setImmediate(resolve));
  };
  const select = (side, entries, directory = false) => {
    get(`#${side}-${directory ? 'directory' : 'file'}`).files = entries.map(e => {
      e.file.name = e.path; e.file.webkitRelativePath = `root/${e.path}`; return e.file;
    });
    get(`#${side}-${directory ? 'directory' : 'file'}`).dispatch('change');
  };
  const controls = busy => {
    assert.equal(get('#compare').disabled, busy);
    assert.equal(get('#self-test').disabled, busy);
    assert.equal(get('#cancel').disabled, !busy);
  };
  const text = (value = 'content', count = 1) => ({ status: 'ok', rows: Array.from({ length: count }, () =>
    ({ kind: 'equal', left: { raw: value }, right: { raw: value } })), differenceCount: 0,
  left: { encoding: 'utf-8' }, right: { encoding: 'utf-8' } });
  return { get, modes, worker: workers[0], workers, latest, result, select, controls, text, timers,
    inspect: expression => vm.runInContext(expression, context),
    lifecycle(type, persisted = true) { for (const fn of events[type] || []) fn({ persisted }); },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); } };
}

test('UI compare/cancel/self-test/compare and failures restore centralized controls; stale results ignored', async () => {
  const ui = setup(); const { get, latest, controls, result } = ui;
  ui.select('left', [entry('file', 'a')]); controls(false);
  get('#compare').click(); controls(true);
  const old = latest();
  get('#self-test').dispatch('click'); // Also exercise the handler guard, not just disabled HTML.
  assert.equal(latest().id, old.id);
  get('#cancel').click(); controls(false);
  get('#self-test').click(); controls(true);
  await result(ui.text(), old.id); controls(true);
  assert.ok(get('#status').textContent.includes('自检'));
  await result({ status: 'complete', counts: { different: 1 } }); controls(false);
  get('#compare').click(); controls(true);
  await result({ status: 'error', reason: 'worker-failed' }); controls(false);
  assert.ok(get('#detail-status').textContent.includes('比较线程失败'));
  get('#self-test').click(); await result({ status: 'error', reason: 'worker-message-failed' }); controls(false);
  get('#self-test').click(); get('#cancel').click(); controls(false);
  await result({ status: 'complete', counts: { different: 1 } }); controls(false);
  assert.ok(get('#status').textContent.startsWith('已取消'));
});

test('UI input and mode changes cancel active tasks without stale state updates', async () => {
  const ui = setup();
  ui.select('left', [entry('old')]); ui.get('#compare').click(); const old = ui.latest();
  ui.select('right', [entry('new')]); ui.controls(false);
  await ui.result(ui.text('obsolete'), old.id);
  assert.equal(ui.get('#text-detail').hidden, true);
  ui.get('#compare').click(); const current = ui.latest();
  ui.modes[1].dispatch('change');
  assert.equal(ui.get('#compare').disabled, true);
  assert.equal(ui.get('#cancel').disabled, true);
  assert.equal(ui.get('#self-test').disabled, false);
  await ui.result(ui.text('obsolete'), current.id);
  assert.equal(ui.get('#text-detail').hidden, true);
});

test('UI directory detail clears old pages, cancels explicitly, isolates A/B/C, and clears on failure', async () => {
  const ui = setup(); const { get, result, controls } = ui;
  ui.modes[1].dispatch('change');
  ui.select('left', ['A', 'B', 'C'].map(p => entry(p, p)), true);
  get('#compare').click();
  await result({ status: 'complete', rows: ['A', 'B', 'C'].map(path => ({ path, status: 'left-only' })),
    counts: { same: 0, different: 0, 'left-only': 3, 'right-only': 0, uncompared: 0, error: 0 } });
  const buttons = get('#results-body').children.map(row => row.children[2].children[0]);
  buttons[0].click(); controls(true);
  await result(ui.text('A', 250)); controls(false);
  get('#next-diff-page').click(); assert.equal(get('#diff-page-label').textContent, '2 / 3');
  buttons[1].click(); controls(true);
  assert.equal(get('#detail-title').textContent, '文本差异 · B');
  assert.equal(get('#diff-body').children.length, 0);
  assert.equal(get('#previous-diff-page').disabled, true); assert.equal(get('#next-diff-page').disabled, true);
  get('#next-diff-page').dispatch('click'); assert.equal(get('#diff-body').children.length, 0);
  get('#cancel').click(); controls(false);
  assert.ok(get('#detail-status').textContent.includes('已取消'));
  assert.equal(get('#diff-page-label').textContent, '');
  await result(ui.text('stale-B')); assert.equal(get('#diff-body').children.length, 0);
  buttons[0].click(); const a = ui.latest(); buttons[1].click(); const b = ui.latest(); buttons[2].click();
  await result(ui.text('stale-A'), a.id); await result(ui.text('stale-B'), b.id); controls(true);
  await result(ui.text('C')); controls(false);
  assert.equal(get('#detail-title').textContent, '文本差异 · C');
  assert.equal(get('#diff-body').children[0].children[0].textContent, 'C');
  assert.equal(get('#diff-page-label').textContent, '1 / 1');
  buttons[1].click(); await result({ status: 'uncompared', reason: 'read-failed' }); controls(false);
  assert.equal(get('#diff-body').children.length, 0);
  assert.ok(get('#detail-status').textContent.includes('读取失败'));
  assert.equal(get('#next-diff-page').disabled, true);
});


test('UI locks text rules during self-test and restores them on all settlement paths', async () => {
  const ui = setup(); const { get } = ui;
  ui.select('left', [entry('file', 'a b')]);
  for (const settlement of ['success', 'failure', 'cancel', 'input', 'mode']) {
    get('#self-test').click();
    const active = ui.latest();
    for (const selector of ['#ignore-whitespace', '#ignore-eol']) {
      assert.equal(get(selector).disabled, true);
      get(selector).dispatch('change');
      assert.equal(ui.latest().id, active.id);
    }
    if (settlement === 'success') await ui.result({ status: 'complete', counts: { different: 1 } });
    if (settlement === 'failure') await ui.result({ status: 'error', reason: 'worker-failed' });
    if (settlement === 'cancel') get('#cancel').click();
    if (settlement === 'input') ui.select('right', [entry('file', 'ab')]);
    if (settlement === 'mode') ui.modes[1].dispatch('change');
    assert.equal(get('#ignore-whitespace').disabled, false);
    assert.equal(get('#ignore-eol').disabled, false);
  }
});

test('UI repeated cached-page restoration recreates workers and rejects unfinished results', async () => {
  const ui = setup(); const { get } = ui;
  ui.select('left', [entry('file', 'a')]);
  ui.lifecycle('pageshow', false); assert.equal(ui.workers.length, 1);
  for (let cycle = 0; cycle < 2; cycle++) {
    get('#compare').click();
    const oldWorker = ui.workers.at(-1); const old = ui.latest();
    ui.lifecycle('pagehide');
    assert.equal(oldWorker.ended, true); ui.controls(false);
    ui.lifecycle('pageshow');
    assert.equal(ui.workers.length, cycle * 2 + 2);
    oldWorker.onmessage({ data: { id: old.id, type: 'result', result: ui.text('stale') } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get('#text-detail').hidden, true);
    get('#self-test').click();
    await ui.result({ status: 'complete', counts: { different: 1 } });
    assert.ok(get('#status').textContent.includes('自检通过'));
    get('#compare').click(); await ui.result(ui.text());
    assert.equal(get('#diff-body').children.length, 1);
    // File text rows have no path; restoring must not run directory filtering.
    get('#path-filter').value = 'any';
    ui.lifecycle('pagehide'); ui.lifecycle('pageshow');
    assert.equal(get('#diff-body').children.length, 1);
  }
});

test('UI directory filter coalesces input, flushes status changes, clears results and uses current path indexes', async () => {
  const ui = setup(); const { get } = ui;
  ui.modes[1].dispatch('change');
  ui.select('left', [entry('Folder/A.txt', 'old'), entry('Folder/B.txt')], true);
  const directory = { status: 'complete', rows: [
    { path: 'Folder/A.txt', status: 'left-only' }, { path: 'Folder/B.txt', status: 'same' }],
  counts: { same: 1, different: 0, 'left-only': 1, 'right-only': 0, uncompared: 0, error: 0 } };
  get('#compare').click(); await ui.result(directory);
  for (const value of ['f', 'folder', 'a.txt']) { get('#path-filter').value = value; get('#path-filter').dispatch('input'); }
  assert.equal(ui.timers.size, 1); assert.equal(get('#results-body').children.length, 2);
  ui.flushTimers();
  assert.equal(get('#results-body').children.length, 1);
  assert.equal(get('#results-body').children[0].children[0].textContent, 'Folder/A.txt');
  get('#path-filter').value = 'b.txt'; get('#path-filter').dispatch('input');
  get('#status-filter').value = 'same'; get('#status-filter').dispatch('change');
  assert.equal(ui.timers.size, 0);
  assert.equal(get('#results-body').children[0].children[0].textContent, 'Folder/B.txt');
  get('#path-filter').dispatch('input');
  const replacement = entry('Folder/A.txt', 'new');
  ui.select('left', [replacement], true);
  assert.equal(ui.timers.size, 0);
  assert.equal(get('#results-body').children.length, 0);
  assert.equal(get('#results-summary').textContent, '');
  assert.equal(ui.inspect('state.filteredRows.length + state.pathKeys.length'), 0);
  assert.equal(ui.inspect('state.result'), null);
  assert.equal(ui.inspect('state.leftByPath.size'), 1);
  get('#path-filter').value = ''; get('#status-filter').value = 'all';
  get('#compare').click(); await ui.result({ ...directory, rows: directory.rows.slice(0, 1) });
  get('#results-body').children[0].children[2].children[0].click();
  assert.equal(ui.latest().left, replacement.file);
  ui.modes[0].dispatch('change');
  assert.equal(ui.inspect('state.leftByPath.size + state.rightByPath.size'), 0);
  assert.equal(get('#results-body').children.length, 0);
});

test('UI filters and paginates the full 40000-path union case-insensitively', async () => {
  const ui = setup(); const { get } = ui;
  ui.modes[1].dispatch('change'); ui.select('left', [entry('selected')], true);
  const rows = ['left', 'right'].flatMap(side => Array.from({ length: 20000 }, (_, i) =>
    ({ path: `${side}/Folder-${i}.txt`, status: `${side}-only` })));
  get('#compare').click(); await ui.result({ status: 'complete', rows,
    counts: { same: 0, different: 0, 'left-only': 20000, 'right-only': 20000, uncompared: 0, error: 0 } });
  assert.equal(get('#page-label').textContent, '1 / 400');
  assert.equal(get('#results-body').children.length, 100);
  get('#path-filter').value = 'RIGHT/FOLDER-19999.TXT'; get('#path-filter').dispatch('input'); ui.flushTimers();
  assert.equal(get('#page-label').textContent, '1 / 1');
  assert.equal(get('#results-body').children[0].children[0].textContent, 'right/Folder-19999.txt');
  get('#status-filter').value = 'left-only'; get('#status-filter').dispatch('change');
  assert.equal(get('#page-label').textContent, '0 / 0'); assert.equal(get('#results-body').children.length, 0);
});
