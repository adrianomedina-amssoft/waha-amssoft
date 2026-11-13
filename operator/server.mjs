import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromNodeHeaders } from 'better-auth/node';
import QRCode from 'qrcode';
import { openAuth, operatorAllowed } from './auth.mjs';
import { StatusService } from './status-service.mjs';
import { GroupService } from './group-service.mjs';
const require = createRequire(import.meta.url);
const express = require('express');
export async function createOperator({ auth, administratorId, origin, upstream, apiKey, expectedNumber, statusService, groupService, timezone = 'America/Porto_Velho' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(function securityHeaders(req, res, next) {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Strict-Transport-Security': 'max-age=31536000' });
    if (req.method !== 'GET' && req.headers.origin !== origin) return res.sendStatus(403);
    next();
  });
  async function session(req) { return auth.api.getSession({ headers: fromNodeHeaders(req.headers) }); }
  app.use('/auth', express.json({ limit: '4kb', inflate: false }), async function authRoutes(req, res, next) {
    try {
      const allowed = { '/sign-in/email': 'POST', '/sign-out': 'POST', '/get-session': 'GET', '/two-factor/enable': 'POST', '/two-factor/verify-totp': 'POST' };
      if (allowed[req.path] !== req.method) return res.sendStatus(404);
      if (req.path === '/sign-in/email') req.body = { email: 'admin@status.invalid', password: req.body.password, rememberMe: false };
      if (req.path === '/two-factor/enable') {
        const current = await session(req);
        if (current?.user?.id !== administratorId || current.user.twoFactorEnabled) return res.sendStatus(403);
        req.body = { password: req.body.password, method: 'totp' };
      }
      if (req.path === '/two-factor/verify-totp') req.body = { code: req.body.code, trustDevice: false };
      const headers = new Headers(fromNodeHeaders(req.headers));
      headers.delete('content-length'); headers.set('host', new URL(origin).host);
      const response = await auth.handler(new Request(origin + '/auth' + req.path, {
        method: req.method, headers: headers,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
      }));
      res.status(response.status);
      response.headers.forEach(function header(value, key) { if (key !== 'set-cookie') res.setHeader(key, value); });
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) { next(error); }
  });
  app.get('/health', function health(req, res) { res.json({ ok: true }); });
  app.get('/', function index(req, res) { res.type('html').send(readFileSync(new URL('./index.html', import.meta.url))); });
  app.get('/app.js', function javascript(req, res) { res.type('js').send(readFileSync(new URL('./app.js', import.meta.url))); });
  app.get('/style.css', function stylesheet(req, res) { res.type('css').send(readFileSync(new URL('./style.css', import.meta.url))); });
  app.use(express.json({ limit: '4kb', inflate: false }));
  app.post('/setup/qr', async function setupQr(req, res, next) {
    try {
      const current = await session(req);
      if (current?.user?.id !== administratorId || current.user.twoFactorEnabled) return res.sendStatus(403);
      const uri = req.body.uri;
      if (typeof uri !== 'string' || uri.length > 2048 || !uri.startsWith('otpauth://totp/')) return res.sendStatus(400);
      res.type('image/svg+xml').send(await QRCode.toString(uri, { type: 'svg' }));
    } catch (error) { next(error); }
  });
  app.use(['/connection', '/status'], async function requireMfa(req, res, next) {
    try { if (!operatorAllowed(await session(req), administratorId)) return res.sendStatus(401); next(); }
    catch (error) { next(error); }
  });
  async function backend(path, method = 'GET', body = undefined, timeout = 20000) {
    const response = await fetch(upstream + path, { method: method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { const error = new Error('WhatsApp backend unavailable'); error.status = response.status; throw error; }
    return response.json();
  }
  function connectionState(result) {
    if (!['STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED'].includes(result.status)) throw new Error('Invalid connection state');
    const number = result.me?.id?.split('@')[0] || null;
    return { status: result.status, number: number, unexpectedNumber: !!(expectedNumber && number && number !== expectedNumber) };
  }
  app.get('/connection', async function connection(req, res, next) {
    try { res.json(connectionState(await backend('/api/sessions/default'))); }
    catch (error) { if (error.status === 404) return res.json({ status: 'STOPPED', number: null }); next(error); }
  });
  app.get('/status', function overview(req, res) {
    if (!statusService) return res.sendStatus(503);
    res.json({ jobs: [...statusService.list(), ...(groupService ? groupService.list() : [])].sort(function newest(a,b) { return b.receivedAt-a.receivedAt; }), timezone: timezone });
  });
  app.post('/status/resolve', function resolveJob(req, res) {
    try { if (!statusService) return res.sendStatus(503); res.json(req.body.kind === 'groups' && groupService ? groupService.resolve(req.body.id, req.body.groupId, req.body.action) : statusService.resolveUnknown(req.body.id, req.body.action)); } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.use('/automation', function automationAuth(req, res, next) {
    if (!statusService || !statusService.authenticate(req.headers.authorization)) return res.sendStatus(401); next();
  });
  app.get('/automation/account', async function automationAccount(req, res, next) { try { const state = await statusService.backend('/api/sessions/default'); res.json({ ready: state.status === 'WORKING' && state.me?.id?.split('@')[0] === expectedNumber }); } catch (error) { next(error); } });
  app.post('/automation/jobs', function automationEnqueue(req, res) {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(function unsupported(key) { return !['id','file','caption'].includes(key); })) throw new Error('A ponte não aceita agendamento; programe a publicação no Postiz');
      res.status(202).json(statusService.enqueue({ source: 'postiz:' + req.body.id, file: req.body.file, caption: req.body.caption || '' }));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/automation/groups', function allowedGroups(req,res) { if(!groupService)return res.sendStatus(503);res.json(groupService.catalog()); });
  app.post('/automation/group-jobs', function groupRequest(req,res) { try { if(!groupService)return res.sendStatus(503);res.status(202).json(groupService.enqueue(req.body)); } catch(error) { res.status(400).json({error:error.message}); } });
  app.get('/automation/group-jobs/:id', function groupReceipt(req,res) { const job=groupService?.job(req.params.id);if(!job)return res.sendStatus(404);res.json(job); });
  app.get('/automation/jobs/:id', function automationJob(req, res) { const job = statusService.job(req.params.id); if (!job) return res.sendStatus(404); res.json(job); });
  let starting = false;
  app.post('/connection/start', async function start(req, res, next) {
    if (starting) return res.status(409).json({ error: 'Uma conexão já está sendo preparada. Aguarde.' });
    starting = true;
    try {
      let existing;
      try { existing = await backend('/api/sessions/default'); } catch (error) { if (error.status !== 404) throw error; }
      let result = existing;
      if (!existing) result = await backend('/api/sessions', 'POST', { name: 'default', start: true, config: {
        webhooks: [], ignore: { status: true, groups: true, channels: true, broadcast: true, dm: true },
        gows: { storage: { messages: false, groups: true, chats: false, labels: false, contacts: true, messageSecrets: false } },
      } });
      else if (existing.status === 'FAILED') result = await backend('/api/sessions/default/restart', 'POST', {});
      else if (existing.status === 'STOPPED') result = await backend('/api/sessions/default/start', 'POST', {});
      const state = connectionState(result);
      if (state.status === 'FAILED') return res.status(503).json({ error: 'Não foi possível gerar um novo QR Code. Tente conectar novamente.' });
      res.json(state);
    } catch (error) { next(error); }
    finally { starting = false; }
  });
  app.get('/connection/qr', async function pairing(req, res, next) {
    try {
      const qr = await backend('/api/default/auth/qr?format=raw');
      if (typeof qr.value !== 'string' || qr.value.length > 8192) throw new Error('Invalid pairing response');
      res.type('image/svg+xml').send(await QRCode.toString(qr.value, { type: 'svg' }));
    } catch (error) { next(error); }
  });
  app.use(function notFound(req, res) { res.sendStatus(404); });
  app.use(function failure(error, req, res, next) { res.status(error.status >= 400 && error.status < 500 ? error.status : 503).json({ error: 'Não foi possível concluir. Tente novamente.' }); });
  return app;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.umask(0o077);
  const directory = process.env.OPERATOR_DATA_DIR || '/data';
  const origin = process.env.OPERATOR_ORIGIN;
  const state = JSON.parse(readFileSync(join(directory, 'operator.json'), 'utf8'));
  const { auth } = await openAuth({ filename: join(directory, 'auth.sqlite'), origin: origin,
    secret: readFileSync(process.env.OPERATOR_SECRET_FILE, 'utf8').trim() });
  const key = readFileSync(process.env.WAHA_API_KEY_FILE, 'utf8').trim();
  async function statusBackend(path, method = 'GET', body = undefined, timeout = 20000) {
    const response = await fetch('http://waha:3000' + path, { method: method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('WhatsApp HTTP ' + response.status); return response.json();
  }
  const statusService = new StatusService({ filename: join(directory, 'status.sqlite'), directories: { postiz: '/postiz-media' }, backend: statusBackend, expectedNumber: process.env.OPERATOR_EXPECTED_NUMBER, token: readFileSync(process.env.POSTIZ_STATUS_TOKEN_FILE, 'utf8').trim() });
  const groupPolicy = process.env.WHATSAPP_GROUPS_POLICY_FILE ? JSON.parse(readFileSync(process.env.WHATSAPP_GROUPS_POLICY_FILE,'utf8')) : { groups: [] };
  const groupService = new GroupService({ filename: join(directory,'groups.sqlite'), directory: '/postiz-media', backend: statusBackend, expectedNumber: process.env.OPERATOR_EXPECTED_NUMBER, groups: groupPolicy.groups });
  const app = await createOperator({ auth: auth, administratorId: state.administratorId, origin: origin, upstream: 'http://waha:3000', apiKey: key, expectedNumber: process.env.OPERATOR_EXPECTED_NUMBER, statusService: statusService, groupService: groupService, timezone: process.env.DISPLAY_TIMEZONE || 'America/Porto_Velho' });
  let dispatching = false;
  const worker = setInterval(async function bridgeTick() { if(dispatching)return;dispatching=true;try { await statusService.tick();await groupService.tick(); } catch(error) { console.error('Bridge worker:',error.message); } finally { dispatching=false; } },1000);worker.unref();
  const server = app.listen(8080, '0.0.0.0', function listening() { console.log('AMS SOFT Status operator listening on 8080'); });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
}
