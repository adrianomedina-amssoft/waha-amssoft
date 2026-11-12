'use strict';
function element(id) { return document.getElementById(id); }
let enrolling = false;
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Senha ou código inválido. Entre novamente.' : 'Não foi possível concluir. Verifique os dados e tente novamente.');
  return response.json();
}
function message(text) { element('message').textContent = text; }
async function image(path, target, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('QR Code indisponível. Aguarde e atualize a conexão.');
  const previous = target.src; target.src = URL.createObjectURL(await response.blob()); target.hidden = false;
  if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
}
async function connection() {
  const result = await api('/connection'); element('connection').textContent = result.status + (result.number ? ' · +' + result.number : '');
  element('pairqr').hidden = true;
  if (result.status === 'SCAN_QR_CODE') await image('/connection/qr', element('pairqr'));
  if (result.number && result.number !== '556993816639') message('Atenção: o aparelho conectado usa outro número.');
}
async function panel() {
  element('login').hidden = true; element('totp').hidden = true; element('setup').hidden = true; element('panel').hidden = false; await connection();
}
function run(task) { return async function handler(event) { event?.preventDefault(); message(''); try { await task(); } catch (error) { message(error.message); } }; }
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
element('start').addEventListener('click', run(async function start() { await api('/connection/start', {}); message('Conexão iniciada. Aguarde alguns segundos e atualize o QR Code.'); await connection(); }));
element('refresh').addEventListener('click', run(connection));
element('logout').addEventListener('click', run(async function logout() { await api('/auth/sign-out', {}); location.reload(); }));
(async function restore() { try { const current = await api('/auth/get-session'); if (current?.session?.operatorMfa && current.user?.twoFactorEnabled) await panel(); } catch (error) { message(error.message); } })();
