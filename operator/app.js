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
  element('login').hidden = true; element('totp').hidden = true; element('setup').hidden = true; element('panel').hidden = false; await connection(); if (element('bridge-history')) await loadStatus();
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

let snapshot;
let historyRequest;

function visibleJob(job) {
  const kind = element('job-kind').value;
  const state = element('job-state').value;
  const deliveries = job.deliveries || [];
  const states = [job.state, ...deliveries.map(delivery => delivery.state)];
  const filters = {
    pending: ['UNKNOWN'], active: ['QUEUED', 'WAITING', 'SENDING'],
    done: ['SENT', 'CONFIRMED'], failed: ['FAILED'],
  };
  return (kind === 'all' || kind === (job.kind || 'status'))
    && (state === 'all' || filters[state].some(value => states.includes(value)));
}

async function loadStatus() {
  if (historyRequest) return historyRequest;
  historyRequest = (async function updateHistory() {
    try {
      const data = await api('/status');
      if (JSON.stringify(data) !== JSON.stringify(snapshot) || element('jobs-feedback').textContent.startsWith('Não foi possível')) {
        snapshot = data;
        renderHistory();
      }
    } catch (error) {
      element('jobs-feedback').textContent = 'Não foi possível atualizar as publicações.';
      throw error;
    } finally {
      historyRequest = null;
    }
  })();
  return historyRequest;
}

function renderHistory() {
  if (!snapshot) return;
  const data = snapshot;
  const jobs = data.jobs.filter(visibleJob);
  element('jobs-feedback').textContent = jobs.length ? '' : 'Nenhuma publicação encontrada.';
  const groups = element('group-list');
  groups.replaceChildren();
  for (const label of data.groups?.length ? [...data.groups].sort((a, b) => a.localeCompare(b, 'pt-BR')) : [data.groups ? 'Nenhum grupo autorizado.' : 'Consulta a grupos indisponível.']) {
    const item = document.createElement('li');
    item.textContent = label;
    groups.append(item);
  }
  const labels={QUEUED:'Recebido do Postiz',WAITING:'Aguardando conexão',SENDING:'Enviando — sem confirmação ainda',SENT:'Confirmado pelo servidor',CONFIRMED:'Confirmado no celular',UNKNOWN:'Verificar resultado no celular',FAILED:'Falha'};
  const container=element('jobs'); const open = new Set([...container.querySelectorAll('details[open]')].map(detail => detail.dataset.job));
  container.replaceChildren();
  for(const job of jobs) { const row=document.createElement('article'); row.className='job'; row.dataset.pending=String(job.state==='UNKNOWN'||Boolean(job.summary?.unknown)); const title=document.createElement('strong'); title.textContent=(job.kind==='groups'?'Grupos':'Status')+' · '+job.file; row.append(title);
    const info=document.createElement('p');info.textContent=new Date(job.receivedAt).toLocaleString('pt-BR',{timeZone:data.timezone})+' · '+(labels[job.state]||job.state);row.append(info);
    if(job.error){const detail=document.createElement('p');detail.textContent=job.error;row.append(detail);}
    if(job.kind!=='groups' && job.state==='UNKNOWN')for(const [action,label]of [['confirmed','Já apareceu no celular'],['not-sent','Não foi publicado']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',run(async function resolve(){await api('/status/resolve',{id:job.id,action:action});await loadStatus();}));row.append(button);}
    if(job.kind==='groups') {
      const summary=document.createElement('p');summary.textContent='Grupos: '+job.summary.sent+'/'+job.summary.total+' confirmados; '+job.summary.failed+' falhas; '+job.summary.unknown+' sem confirmação';row.append(summary);
      const details = document.createElement('details');
      details.dataset.job = job.id;
      details.open = open.has(job.id) || job.summary.unknown > 0;
      const disclosure = document.createElement('summary');
      disclosure.textContent = 'Ver entregas por grupo';
      details.append(disclosure);
      row.append(details);
      for (const delivery of job.deliveries) {
        const detail=document.createElement('p');detail.textContent=delivery.title+' · '+(labels[delivery.state]||delivery.state)+(delivery.error?' · '+delivery.error:'');details.append(detail);
        if(delivery.state==='UNKNOWN')for(const [action,label]of [['confirmed','Envio confirmado neste grupo'],['not-sent','Não publicado neste grupo']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',run(async function resolveGroup(){await api('/status/resolve',{id:job.id,kind:'groups',groupId:delivery.groupId,action:action});await loadStatus();}));details.append(button);}
      }
    }
    container.append(row);
  }
}
if(element('bridge-history')) {
  element('job-kind').addEventListener('change', renderHistory);
  element('job-state').addEventListener('change', renderHistory);
  setInterval(function updateJobs(){if(!element('panel').hidden)loadStatus().catch(function error(e){if(e.status===401)loginRequired();else message(e.message);});},10000);
}
