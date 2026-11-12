import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createOperator } from './server.mjs';
test('JSON endpoints reject compressed requests before decoding and stay healthy', async function compression() {
  const auth = { handler: async function handle() { return Response.json({ fixture: true }); }, api: { getSession: async function noSession() { return null; } } };
  const app = await createOperator({ auth: auth, administratorId: 'fixture', origin: 'http://localhost:8080', upstream: 'http://invalid', apiKey: 'fixture' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const content = Buffer.from(JSON.stringify({ password: 'benign-audit-fixture' }));
  try {
    for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
      for (const path of ['/auth/sign-in/email', '/setup/qr']) {
        const response = await fetch(url + path, { method: 'POST', headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body: compress(content) });
        assert.equal(response.status, 415);
        assert.equal((await fetch(url + '/health')).status, 200);
      }
    }
    const ordinary = await fetch(url + '/auth/sign-in/email', { method: 'POST', headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json' }, body: content });
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), { fixture: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('plain JSON body limit is enforced before authentication work', async function limit() {
  const app = await createOperator({ auth: {}, administratorId: 'fixture', origin: 'http://localhost:8080', upstream: 'http://invalid', apiKey: 'fixture' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/auth/sign-in/email', { method: 'POST', headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(5000) }) });
    assert.equal(response.status, 413);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
