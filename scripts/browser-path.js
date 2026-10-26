import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function browserCandidates(platform, env, home) {
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.posix.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  if (platform === 'win32') {
    return [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA,
      'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean))].flatMap(root => [
      path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  if (platform === 'linux') return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  return [];
}

async function isExecutableFile(filename) {
  try {
    await access(filename, constants.X_OK);
    return (await stat(filename)).isFile();
  } catch { return false; }
}

export async function findBrowser({ env = process.env, platform = process.platform, home = os.homedir(),
  isExecutable = isExecutableFile } = {}) {
  const example = platform === 'win32'
    ? '$env:CHROME_PATH="C:\\path\\to\\chrome.exe"; npm run test:browser'
    : 'CHROME_PATH="/path/to/chrome" npm run test:browser';
  if (env.CHROME_PATH !== undefined) {
    if (env.CHROME_PATH && await isExecutable(env.CHROME_PATH)) return env.CHROME_PATH;
    throw new Error(`CHROME_PATH is not an executable file: ${JSON.stringify(env.CHROME_PATH)}. Example: ${example}`);
  }
  const candidates = browserCandidates(platform, env, home);
  for (const filename of candidates) if (await isExecutable(filename)) return filename;
  throw new Error(`Chrome/Edge/Chromium not found. Set CHROME_PATH. Example: ${example}. Tried: ${candidates.join(', ') || '(no defaults for this platform)'}`);
}
