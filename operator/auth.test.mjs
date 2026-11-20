import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openAuth, operatorAllowed } from './auth.mjs';
import { createOperator } from './server.mjs';
function otp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const char of secret.toUpperCase().replace(/=/g, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = Buffer.from((bits.match(/.{8}/g) || []).map(function byte(value) { return parseInt(value, 2); }));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest(); const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
test('TOTP enrollment, old-session rejection and fresh two-factor sign-in', async function flow() {
  const origin = 'http://localhost:8080'; const password = 'Fixture-password-only-123456!';
  const { auth, database } = await openAuth({ filename: ':memory:', origin: origin, secret: 'fixture-not-a-production-secret-1234567890', bootstrap: true });
  const user = await auth.api.signUpEmail({ body: { email: 'admin@status.invalid', password: password, name: 'Test' } });
  database.prepare('DELETE FROM session').run(); const cookies = new Map();
  async function request(path, body) {
    const response = await auth.handler(new Request(origin + '/auth' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'Origin': origin, 'Cookie': Array.from(cookies).map(([key,value]) => key + '=' + value).join('; ') }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const index = pair.indexOf('='); cookies.set(pair.slice(0,index), pair.slice(index+1)); }
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('/sign-in/email', { email: 'admin@status.invalid', password: password })).status,200);
  assert.equal(operatorAllowed((await request('/get-session')).data,user.user.id),false);
  const oldCookies = new Map(cookies);
  const enrollment = await request('/two-factor/enable', { password: password, method: 'totp' }); assert.equal(enrollment.status,200);
  assert.equal((await request('/two-factor/verify-totp', { code: '000000' })).status,401);
  const secret = new URL(enrollment.data.totpURI).searchParams.get('secret');
  assert.equal((await request('/two-factor/verify-totp', { code: otp(secret) })).status,200);
  assert.equal((await request('/get-session')).data.user.twoFactorEnabled,true);
  await request('/sign-out', {});
  // Separate enrollment and login windows while retaining the real limiter.
  await new Promise(resolve => setTimeout(resolve, 11000));
  cookies.clear(); for (const [key,value] of oldCookies) cookies.set(key,value);
  assert.equal((await request('/get-session')).data,null); cookies.clear();
  assert.equal((await request('/sign-in/email', { email: 'admin@status.invalid', password: password })).data.twoFactorRedirect,true);
  assert.equal((await request('/get-session')).data,null);
  assert.equal((await request('/two-factor/verify-totp', { code: '000000' })).status,401);
  assert.equal((await request('/two-factor/verify-totp', { code: otp(secret) })).status,200);
  assert.equal(operatorAllowed((await request('/get-session')).data,user.user.id),true);
  database.close();
});
test('gateway denies API bypasses and foreign-origin mutations', async function boundaries() {
  const app = await createOperator({ auth: { api: { getSession: async function noSession() { return null; } } }, administratorId: 'fixture', origin: 'http://localhost:8080', upstream: 'http://invalid', apiKey: 'fixture' });
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const path of ['/api/sessions','/dashboard/','/auth/sign-up/email','/auth/two-factor/disable','/auth/two-factor/verify-backup-code']) assert.equal((await fetch(url+path)).status,404);
    assert.equal((await fetch(url+'/connection')).status,401);
    assert.equal((await fetch(url+'/connection/start',{method:'POST'})).status,403);
    assert.equal((await fetch(url+'/setup/qr',{method:'POST',headers:{Origin:'http://localhost:8080','Content-Type':'application/json'},body:'{}'})).status,403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('gateway enrollment uses secure policy and keeps connection locked before TOTP', async function httpFlow() {
  const origin = 'http://localhost:8080'; const password = 'Fixture-password-only-123456!';
  const { auth, database } = await openAuth({ filename: ':memory:', origin: origin, secret: 'fixture-not-a-production-secret-1234567890', bootstrap: true });
  const user = await auth.api.signUpEmail({ body: { email: 'admin@status.invalid', password: password, name: 'Test' } });
  database.prepare('DELETE FROM session').run();
  const app = await createOperator({ auth: auth, administratorId: user.user.id, origin: origin, upstream: 'http://invalid', apiKey: 'fixture' });
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  const url = 'http://127.0.0.1:' + server.address().port; let cookie = '';
  async function request(path, body) {
    const response = await fetch(url+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
    const cookies = response.headers.getSetCookie(); if (cookies.length) cookie = cookies.map(value=>value.split(';')[0]).join('; ');
    return response;
  }
  try {
    const login = await request('/auth/sign-in/email',{password:password,email:'attacker@example.invalid'}); assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie'),/HttpOnly/i);
    assert.equal((await request('/connection')).status,401);
    const current = await (await request('/auth/get-session')).json(); assert.equal(current.user.id,user.user.id);
    assert.equal((await request('/auth/two-factor/disable',{})).status,404);
    const setup = await (await request('/auth/two-factor/enable',{password:password,method:'otp'})).json();
    assert.match(setup.totpURI,/^otpauth:\/\/totp\//);
    const qr = await request('/setup/qr',{uri:setup.totpURI}); assert.equal(qr.status,200); assert.match(await qr.text(),/<svg/);
    assert.equal((await request('/connection')).status,401);
  } finally { await new Promise(resolve => server.close(resolve)); database.close(); }
});
