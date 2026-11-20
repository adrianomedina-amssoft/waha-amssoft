import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createOperator } from './server.mjs';
const require = createRequire(import.meta.url);
const express = require('express');
async function listen(app) {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { server: server, url: 'http://127.0.0.1:' + server.address().port };
}
async function fixture({ status, resultingStatus = 'SCAN_QR_CODE', missing = false, delay = 0 }) {
  const calls = []; let current = status;
  const backend = express(); backend.use(express.json());
  backend.use(function record(req,res,next) { calls.push(req.method + ' ' + req.path); assert.equal(req.headers['x-api-key'],'fixture-key'); next(); });
  backend.get('/api/sessions/default',function get(req,res) { if (missing) return res.sendStatus(404); res.json({ status: current }); });
  backend.post(['/api/sessions/default/start','/api/sessions/default/restart','/api/sessions'],async function mutate(req,res) { if (delay) await new Promise(resolve=>setTimeout(resolve,delay)); current = resultingStatus; res.json({ status: current }); });
  backend.get('/api/default/auth/qr',function qr(req,res) { assert.equal(req.query.format,'raw'); res.json({ value: 'fixture-qr-not-for-a-real-account' }); });
  const upstream = await listen(backend);
  const auth = { api: { getSession: async function session() { return { user: { id: 'fixture-admin', twoFactorEnabled: true }, session: { operatorMfa: true } }; } } };
  const app = await createOperator({ auth: auth, administratorId: 'fixture-admin', origin: 'http://localhost:8080', upstream: upstream.url, apiKey: 'fixture-key' });
  const gateway = await listen(app);
  return { url: gateway.url, calls: calls, close: async function close() { await new Promise(resolve=>gateway.server.close(resolve)); await new Promise(resolve=>upstream.server.close(resolve)); } };
}
for (const scenario of [
  { status: 'FAILED', action: '/api/sessions/default/restart' },
  { status: 'STOPPED', action: '/api/sessions/default/start' },
  { status: 'SCAN_QR_CODE', action: null },
  { status: 'STARTING', action: null },
  { status: 'WORKING', action: null },
  { status: 'STOPPED', missing: true, action: '/api/sessions' },
]) test('connection recovery for ' + scenario.status + (scenario.missing ? ' missing' : ''), async function recovery() {
  const fixtureApp = await fixture(scenario);
  try {
    const response = await fetch(fixtureApp.url+'/connection/start',{ method:'POST',headers:{ Origin:'http://localhost:8080','Content-Type':'application/json' },body:'{}' });
    assert.equal(response.status,200); const data=await response.json();
    assert.equal(data.status,scenario.action ? 'SCAN_QR_CODE' : scenario.status);
    const mutations = fixtureApp.calls.filter(value=>value.startsWith('POST'));
    assert.deepEqual(mutations,scenario.action ? ['POST '+scenario.action] : []);
    assert.equal(fixtureApp.calls.some(value=>value.includes('logout')||value.includes('delete')),false);
    if (data.status==='SCAN_QR_CODE') { const qr=await fetch(fixtureApp.url+'/connection/qr'); assert.equal(qr.status,200); assert.match(await qr.text(),/<svg/); }
  } finally { await fixtureApp.close(); }
});
test('failure cannot be reported as successful connection',async function failure() {
  const fixtureApp = await fixture({status:'FAILED',resultingStatus:'FAILED'});
  try {
    const response=await fetch(fixtureApp.url+'/connection/start',{method:'POST',headers:{Origin:'http://localhost:8080','Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,503);assert.match((await response.json()).error,/QR Code/);
  } finally {await fixtureApp.close();}
});
test('concurrent retries do not restart a session twice',async function concurrency() {
  const fixtureApp=await fixture({status:'FAILED',delay:100});
  try {
    const replies=await Promise.all([1,2].map(function request(){return fetch(fixtureApp.url+'/connection/start',{method:'POST',headers:{Origin:'http://localhost:8080','Content-Type':'application/json'},body:'{}'});}));
    assert.deepEqual(replies.map(value=>value.status).sort(),[200,409]);
    assert.equal(fixtureApp.calls.filter(value=>value==='POST /api/sessions/default/restart').length,1);
  } finally {await fixtureApp.close();}
});
