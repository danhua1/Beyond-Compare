import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Exact production allowlist: never serve a directory, test, script or dotfile.
export const RESOURCES = Object.freeze([
  '/index.html', '/src/main.js', '/src/styles.css',
  '/src/core/limits.js', '/src/core/paths.js', '/src/core/bytes.js',
  '/src/core/text.js', '/src/core/diff.js', '/src/io/files.js',
  '/src/io/compare-client.js', '/src/workers/compare-worker.js',
]);
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createStaticServer({ onRequest } = {}) {
  return http.createServer(async (req, res) => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
    const respond = (code, message) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    // No body parser or request logging. Test observers see no body/headers.
    onRequest?.({ method: req.method, url: req.url });
    const address = serverAddress(req);
    if (!address || req.headers.host !== `127.0.0.1:${address.port}`) return respond(403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return respond(405, 'Method not allowed');
    }
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); }
    catch { return respond(400, 'Bad path'); }
    if (pathname === '/') pathname = '/index.html';
    if (!RESOURCES.includes(pathname)) return respond(404, 'Not found');
    try {
      const filename = path.join(ROOT, pathname);
      // Reject symlink escapes even if an allowlisted file is replaced locally.
      if (await realpath(filename) !== filename) return respond(403, 'Forbidden');
      const data = await readFile(filename);
      const type = pathname.endsWith('.html') ? 'text/html' :
        pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
      res.writeHead(200, { ...headers, 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { respond(404, 'Not found'); }
  });
}

function serverAddress(req) { return req.socket.localAddress === '127.0.0.1' ? { port: req.socket.localPort } : null; }

export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rawPort = process.env.PORT || '4173';
  const port = /^\d+$/u.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer from 1 to 65535'); process.exitCode = 1;
  } else {
    const server = createStaticServer();
    listen(server, port).then(url => console.log(`Local file compare: ${url}`)).catch(error => {
      console.error(`Static server failed: ${error.code || 'unknown'}`); process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  }
}
