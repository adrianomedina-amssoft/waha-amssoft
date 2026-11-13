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
  element('login').hidden = true; element('totp').hidden = true; element('setup').hidden = true; element('panel').hidden = false; await connection(); if (element('publishing')) await loadStatus(true);
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

let statusLoaded = false;
let statusIntent = null;
async function loadStatus(initial = false) {
  const data = await api('/status'); element('status-timezone').textContent=({'America/Porto_Velho':'Rondônia','America/Sao_Paulo':'São Paulo'}[data.config.timezone]||data.config.timezone); const select = element('video');
  const signature = data.assets.map(a=>a.file).join('|');
  if (select.dataset.signature !== signature) { const previous = select.value; select.replaceChildren(); for (const asset of data.assets) { const option=document.createElement('option'); option.value=asset.file; option.textContent=asset.name+' ('+(asset.bytes/1048576).toFixed(1)+' MiB)'; select.append(option); } if(data.assets.some(a=>a.file===previous))select.value=previous; select.dataset.signature=signature; }
  if (initial || !statusLoaded) { element('daily-enabled').checked=!!data.config.enabled; element('daily-hour').value=data.config.start_hour; element('daily-interval').value=data.config.interval_minutes; statusLoaded=true; }
  const agenda=element('native-agenda');agenda.replaceChildren();for(const entry of (data.agenda||[])){const p=document.createElement('p');p.textContent=entry.file+' · '+entry.localTime+' · '+(entry.repeat?'Repete diariamente no Postiz':'Agendado no Postiz');agenda.append(p);}
  const labels={QUEUED:'Agendado',WAITING:'Aguardando conexão',SENDING:'Enviando — sem confirmação ainda',SENT:'Confirmado pelo servidor',CONFIRMED:'Confirmado no celular',UNKNOWN:'Verificar resultado no celular',FAILED:'Falha'};
  const container=element('jobs'); container.replaceChildren();
  for(const job of data.jobs) { const row=document.createElement('article'); row.className='job'; const title=document.createElement('strong'); title.textContent=job.file; row.append(title);
    const info=document.createElement('p');info.textContent=new Date(job.due).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' · '+(labels[job.state]||job.state);row.append(info);
    if(job.error){const detail=document.createElement('p');detail.textContent=job.error;row.append(detail);}
    if(job.state==='UNKNOWN')for(const [action,label]of [['confirmed','Já apareceu no celular'],['not-sent','Não foi publicado']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',run(async function resolve(){await api('/status/resolve',{id:job.id,action:action});await loadStatus();}));row.append(button);}
    container.append(row);
  }
}
async function submitStatus(immediate) {
  const file=element('video').value;if(!file)throw new Error('Selecione um vídeo da biblioteca.');
  const due=Date.now();const dueLocal=immediate?undefined:element('publish-at').value;if(!immediate&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueLocal))throw new Error('Escolha uma data futura.');
  const caption=element('caption').value;const key=file+'|'+(immediate?'now':dueLocal)+'|'+caption;
  if(!statusIntent||statusIntent.key!==key)statusIntent={key:key,id:crypto.randomUUID()};
  await api('/status/jobs',{requestId:statusIntent.id,file:file,due:due,dueLocal:dueLocal,caption:caption});statusIntent=null;
  message('Vídeo na fila. A confirmação será mostrada no histórico.');await loadStatus();
}
if(element('publishing')) {
  element('publish-now').addEventListener('click',run(async function publish(){await submitStatus(true);}));
  element('schedule-video').addEventListener('click',run(async function schedule(){await submitStatus(false);}));
  element('save-daily').addEventListener('click',run(async function save(){await api('/status/config',{enabled:element('daily-enabled').checked,interval_minutes:Number(element('daily-interval').value),start_hour:Number(element('daily-hour').value)});message('Programação salva. O calendário do Postiz será atualizado em até 1 minuto.');await loadStatus();}));
  setInterval(function updateJobs(){if(!element('panel').hidden)loadStatus().catch(function error(e){if(e.status===401)loginRequired();else message(e.message);});},10000);
}
