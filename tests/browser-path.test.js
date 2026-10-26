import { assert, test } from './harness.js';
import { browserCandidates, findBrowser } from '../scripts/browser-path.js';

test('browser path explicit override wins and invalid override never falls back', async () => {
  const checked = [];
  const isExecutable = async p => { checked.push(p); return p === '/custom/chrome'; };
  assert.equal(await findBrowser({ env: { CHROME_PATH: '/custom/chrome' }, isExecutable }), '/custom/chrome');
  assert.deepEqual(checked, ['/custom/chrome']);
  for (const value of ['', '/missing']) {
    await assert.rejects(findBrowser({ env: { CHROME_PATH: value }, isExecutable }), /CHROME_PATH.*Example:/u);
  }
});

test('browser defaults cover platform-specific common locations with clear missing errors', async () => {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(await findBrowser({ platform: 'darwin', env: {}, home: '/home/test',
    isExecutable: async p => p === mac }), mac);
  assert.ok(browserCandidates('linux', {}, '').includes('/usr/bin/chromium'));
  const windows = browserCandidates('win32', { LOCALAPPDATA: String.raw`D:\Users\test\AppData\Local` }, '');
  assert.ok(windows.includes(String.raw`D:\Users\test\AppData\Local\Google\Chrome\Application\chrome.exe`));
  assert.ok(windows.includes(String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`));
  for (const platform of ['darwin', 'linux', 'win32', 'unknown']) {
    await assert.rejects(findBrowser({ platform, env: {}, isExecutable: async () => false }), /not found.*CHROME_PATH.*Example:/u);
  }
});
