import http from 'node:http';
import { assert, test } from './harness.js';
import { createStaticServer, listen, RESOURCES, CSP } from '../scripts/server.js';

export function request(url, resource, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    const req = http.request({ hostname: address.hostname, port: address.port, path: resource, method, headers }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP timeout')));
    req.end(method === 'POST' ? 'controlled-private-fixture' : undefined);
  });
}

test('loopback-only server, exact resource allowlist, MIME, CSP and no uploads', async () => {
  const server = createStaticServer();
  const url = await listen(server);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    for (const resource of ['/', ...RESOURCES]) {
      const response = await request(url, resource);
      assert.equal(response.status, 200, resource);
      assert.equal(response.headers['content-security-policy'], CSP);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      if (resource.endsWith('.js')) assert.match(response.headers['content-type'], /^text\/javascript/u);
    }
    for (const resource of ['/README.md', '/package.json', '/scripts/server.js', '/tests/browser.js', '/.workflow/state.json',
      '/.git/config', '/.DS_Store', '/src/', '/src/missing.js', '/%2e%2e/README.md', '/src/%2e%2e/main.js',
      '/src/../main.js', '/src//main.js', '/%2eWorkflow/REQUEST.md', '/src/main.js/anything', '/src/main.js%00',
      '/%252e%252e/README.md', '/src\\main.js']) {
      assert.notEqual((await request(url, resource)).status, 200, resource);
    }
    assert.equal((await request(url, '/%zz')).status, 400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      const response = await request(url, '/', method);
      assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET, HEAD');
      assert.ok(!response.body.includes('controlled-private-fixture'));
    }
    assert.equal((await request(url, '/', 'HEAD')).body, '');
    assert.equal((await request(url, '/', 'GET', { Host: 'evil.example' })).status, 403);
    // Send raw paths, never a URL parser's normalized traversal target.
    for (const resource of ['/src/../index.html', '/src/%2e%2e/index.html', '//index.html']) {
      const response = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path: resource }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      });
      assert.equal(response, 404);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('occupied port is an explicit startup error', async () => {
  const first = createStaticServer(); const second = createStaticServer();
  await listen(first);
  try { await assert.rejects(listen(second, first.address().port), error => error.code === 'EADDRINUSE'); }
  finally { await new Promise(resolve => first.close(resolve)); }
});
