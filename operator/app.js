'use strict';
function element(id) { return document.getElementById(id); }
let enrolling = false;
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    let details; try { details = await response.json(); } catch (error) { details = null; }
    const failure = new Error(response.status === 401 ? 'Senha ou código inválido ou sessão expirada. Entre novamente.' : details?.error || 'Não foi possível concluir. Tente novamente.');
    failure.status = response.status; throw failure;
  }
  return response.json();
}
function message(text) { element('message').textContent = text; }
async function image(path, target, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('QR Code indisponível. Aguarde e atualize a conexão.');
  const previous = target.src; target.src = URL.createObjectURL(await response.blob()); target.hidden = false;
  if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
}
let pollTimer = null;
let lastStatus = null;
let busy = false;
let connectionPromise = null;
function stopPolling() { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; }
function buttons() {
  element('start').disabled = busy || ['STARTING', 'SCAN_QR_CODE', 'WORKING'].includes(lastStatus);
  element('refresh').disabled = busy;
}
function loginRequired() {
  stopPolling(); element('panel').hidden = true; element('totp').hidden = true; element('setup').hidden = true; element('login').hidden = false;
}
function poll() {
  stopPolling();
  if (element('panel').hidden || !['STARTING', 'SCAN_QR_CODE'].includes(lastStatus)) return;
  pollTimer = setTimeout(async function tick() {
    pollTimer = null;
    try { await connection(); }
    catch (error) { message(error.message); if (error.status === 401) loginRequired(); else poll(); }
  }, 3000);
}
async function updateConnection() {
  stopPolling();
  const result = await api('/connection'); lastStatus = result.status;
  const labels = { STOPPED: 'Desconectado', STARTING: 'Preparando conexão…', SCAN_QR_CODE: 'Aguardando leitura do QR Code', WORKING: 'WhatsApp conectado', FAILED: 'Conexão interrompida' };
  element('connection').textContent = (labels[result.status] || result.status) + (result.number ? ' · +' + result.number : '');
  buttons();
  if (result.status === 'SCAN_QR_CODE') {
    try { await image('/connection/qr', element('pairqr')); message('Escaneie o QR Code com o WhatsApp. Ele será atualizado automaticamente.'); }
    catch (error) { element('pairqr').hidden = true; message('Atualizando o QR Code. Aguarde alguns segundos…'); }
  } else {
    element('pairqr').hidden = true;
    if (result.status === 'FAILED') message('A conexão falhou ou o QR Code expirou. Clique em Conectar WhatsApp para tentar novamente.');
    else if (result.status === 'STARTING') message('Preparando um novo QR Code. Aguarde…');
    else if (result.status === 'WORKING') message('WhatsApp conectado.');
  }
  if (result.unexpectedNumber) message('Atenção: o aparelho conectado usa outro número.');
  poll(); return result;
}
async function connection() {
  if (connectionPromise) return connectionPromise;
  connectionPromise = updateConnection();
  try { return await connectionPromise; } finally { connectionPromise = null; }
}
async function startConnection() {
  stopPolling(); message('Preparando conexão…');
  await api('/connection/start', {});
  return connection();
}
async function panel() {
  element('login').hidden = true; element('totp').hidden = true; element('setup').hidden = true; element('panel').hidden = false; await connection();
}
function run(task) { return async function handler(event) {
  event?.preventDefault(); if (busy) return; busy = true; buttons(); message('');
  try { await task(); } catch (error) { message(error.message); if (error.status === 401 && !element('panel').hidden) loginRequired(); }
  finally { busy = false; buttons(); }
}; }
element('login').addEventListener('submit', run(async function login() {
  const password = element('password').value;
  const result = await api('/auth/sign-in/email', { password: password }); element('password').value = '';
  if (result.twoFactorRedirect) { element('login').hidden = true; element('totp').hidden = false; return; }
  const current = await api('/auth/get-session'); if (!current?.user) throw new Error('Entre novamente.');
  if (current.user.twoFactorEnabled) return panel();
  const setup = await api('/auth/two-factor/enable', { password: password });
  await image('/setup/qr', element('setupqr'), { uri: setup.totpURI });
  enrolling = true; element('login').hidden = true; element('setup').hidden = false; element('totp').hidden = false;
}));
element('totp').addEventListener('submit', run(async function verify() {
  await api('/auth/two-factor/verify-totp', { code: element('code').value }); element('code').value = '';
  if (enrolling) {
    await api('/auth/sign-out', {}); enrolling = false; element('setup').hidden = true; element('totp').hidden = true; element('login').hidden = false;
    message('Segundo fator ativado. Entre com sua senha e o código do autenticador.'); return;
  }
  await panel();
}));
element('start').addEventListener('click', run(startConnection));
element('refresh').addEventListener('click', run(async function refresh() {
  const state = await connection();
  if (state.status === 'FAILED' || state.status === 'STOPPED') await startConnection();
}));
element('logout').addEventListener('click', run(async function logout() { stopPolling(); await api('/auth/sign-out', {}); location.reload(); }));
(async function restore() { try { const current = await api('/auth/get-session'); if (current?.session?.operatorMfa && current.user?.twoFactorEnabled) await panel(); } catch (error) { message(error.message); } })();
