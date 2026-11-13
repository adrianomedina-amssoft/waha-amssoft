import { createRequire } from 'node:module';
import { openSync, closeSync, readSync, readFileSync, readdirSync, realpathSync, lstatSync, fstatSync, constants } from 'node:fs';
import { resolve, relative, sep, basename, dirname } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
export class StatusService {
  constructor({ filename, directories, backend, expectedNumber, token, clock = Date.now, timezone = 'America/Sao_Paulo', externalScheduler = false }) {
    this.db = new Database(filename); this.db.pragma('foreign_keys = ON'); this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS status_jobs(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,namespace TEXT NOT NULL,file TEXT NOT NULL,hash TEXT NOT NULL,caption TEXT NOT NULL,due INTEGER NOT NULL,state TEXT NOT NULL,message_id TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS status_sources(source TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES status_jobs(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS status_config(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,interval_minutes INTEGER NOT NULL DEFAULT 60,start_hour INTEGER NOT NULL DEFAULT 6,timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo');
      `);
    this.db.prepare("UPDATE status_jobs SET state='UNKNOWN',error='Serviço reiniciado durante envio; verificar no celular' WHERE state='SENDING'").run();
    this.db.prepare('INSERT OR IGNORE INTO status_config(id,timezone) VALUES(1,?)').run(timezone);
    this.externalScheduler = externalScheduler; this.agendaFile = filename === ':memory:' ? null : resolve(dirname(filename), 'postiz-agenda.json');
    this.directories = directories; this.backend = backend; this.expectedNumber = expectedNumber; this.token = token; this.clock = clock; this.busy = false; this.assetCache = new Map();
  }
  authenticate(value) { const a = Buffer.from(value || ''); const b = Buffer.from('Bearer ' + this.token); return !!this.token && a.length === b.length && timingSafeEqual(a, b); }
  readAsset(namespace, name, content = false) {
    const root = this.directories[namespace]; if (!root || typeof name !== 'string' || !name || name.length > 1024 || name.includes('\0')) throw new Error('Arquivo inválido');
    const base = realpathSync(root); const target = resolve(base, name); const rel = relative(base, target);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || target === base || resolve(name) === name) throw new Error('Arquivo fora da biblioteca');
    let cursor = base; for (const part of rel.split(sep)) { cursor = resolve(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('Links não são permitidos'); }
    if (realpathSync(target) !== target || !target.toLowerCase().endsWith('.mp4')) throw new Error('Somente vídeos MP4');
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) throw new Error('Vídeo deve ter até 32 MiB');
      const cacheKey = namespace + ':' + rel; const cached = this.assetCache.get(cacheKey);
      if (!content && cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.asset;
      const data = Buffer.alloc(stat.size); let offset = 0; while (offset < data.length) { const count = readSync(fd,data,offset,data.length-offset,offset); if (!count) break; offset += count; }
      const after = fstatSync(fd); if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Arquivo está sendo alterado; aguarde terminar a cópia'); if (!data.subarray(0, 64).includes(Buffer.from('ftyp'))) throw new Error('MP4 inválido');
      const asset = { file: rel, name: basename(rel), bytes: stat.size, hash: createHash('sha256').update(data).digest('hex') };
      this.assetCache.set(cacheKey, { size: stat.size, mtime: stat.mtimeMs, asset: asset });
      return { ...asset, ...(content ? { data: data } : {}) };
    } finally { closeSync(fd); }
  }
  catalog() { const result = []; for (const name of readdirSync(this.directories.ads)) { try { result.push(this.readAsset('ads', name)); } catch (error) {} } return result.sort(function order(a,b) { return a.file.localeCompare(b.file); }); }
  enqueue({ source, namespace = 'ads', file, due = this.clock(), caption = '' }) {
    if (typeof source !== 'string' || !/^[a-zA-Z0-9:/_.-]{1,180}$/.test(source) || typeof caption !== 'string' || caption.length > 1024 || !Number.isSafeInteger(due) || due < 0) throw new Error('Agendamento inválido');
    const asset = this.readAsset(namespace, file); const previous = this.db.prepare('SELECT j.* FROM status_jobs j LEFT JOIN status_sources s ON s.job_id=j.id WHERE j.source=? OR s.source=? LIMIT 1').get(source,source);
    if (previous) { if (previous.hash !== asset.hash) throw new Error('Chave já utilizada por outro vídeo'); return this.publicJob(previous); }
    if (source.startsWith('daily:') || source.startsWith('postiz:')) {
      const matching = this.db.prepare("SELECT * FROM status_jobs WHERE hash=? AND abs(due-?)<=120000 AND state<>'FAILED' AND (source LIKE 'daily:%' OR source LIKE 'postiz:%') ORDER BY created LIMIT 1").get(asset.hash,due);
      if (matching) { this.db.prepare('INSERT OR IGNORE INTO status_sources VALUES(?,?)').run(source,matching.id); return this.publicJob(matching); }
    }
    const id = randomUUID(); const now = this.clock();
    this.db.prepare('INSERT INTO status_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, source, namespace, asset.file, asset.hash, caption, due, 'QUEUED', null, null, now, now);
    return this.job(id);
  }
  publicJob(row) { if (!row) return null; return { id: row.id, source: row.source, file: row.file, due: row.due, state: row.state, messageId: row.message_id, error: row.error, updated: row.updated }; }
  job(id) { return this.publicJob(this.db.prepare('SELECT * FROM status_jobs WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM status_jobs ORDER BY due DESC LIMIT 150').all().map(this.publicJob); }
  config() { return this.db.prepare('SELECT * FROM status_config WHERE id=1').get(); }
  configure({ enabled, interval_minutes, start_hour }) {
    if (typeof enabled !== 'boolean' || ![30,60].includes(interval_minutes) || !Number.isInteger(start_hour) || start_hour < 0 || start_hour > 23) throw new Error('Configuração inválida');
    this.db.prepare('UPDATE status_config SET enabled=?,interval_minutes=?,start_hour=? WHERE id=1').run(Number(enabled),interval_minutes,start_hour);
    // Already queued automatic slots can be rebuilt; sending/completed jobs are preserved.
    this.db.prepare("DELETE FROM status_jobs WHERE source LIKE 'daily:%' AND state='QUEUED' AND due>?").run(this.clock());
    return this.config();
  }
  resolveUnknown(id, action) {
    if (!['confirmed','not-sent'].includes(action)) throw new Error('Ação inválida');
    const row = this.db.prepare('SELECT * FROM status_jobs WHERE id=?').get(id); if (!row || row.state !== 'UNKNOWN') throw new Error('Envio não está pendente de confirmação');
    this.db.prepare('UPDATE status_jobs SET state=?,error=?,updated=? WHERE id=?').run(action === 'confirmed' ? 'CONFIRMED' : 'FAILED',action === 'confirmed' ? 'Confirmado pelo proprietário no celular' : 'Proprietário informou que não foi publicado; reenvio exige nova ação',this.clock(),id);
    return this.job(id);
  }
  agenda() { try { return this.agendaFile ? JSON.parse(readFileSync(this.agendaFile, 'utf8')) : []; } catch (error) { return []; } }
  localTimestamp(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw new Error('Data inválida');
    const target = Date.parse(text + ':00Z'); let guess = target;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: this.config().timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (let i=0;i<3;i++) { const p = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value])); const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`); guess += target - shown; }
    return guess;
  }
  plan() {
    if (this.externalScheduler) return;
    const config = this.config(); if (!config.enabled) return;
    const now = this.clock(); const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`; const assets = this.catalog();
    // Resolve configured local wall time without relying on the browser timezone.
    for (let d=0;d<2;d++) { const day = new Date(Date.parse(today+'T12:00:00-03:00')+d*86400000).toISOString().slice(0,10);
      for (let i=0;i<assets.length;i++) { const at=this.localTimestamp(day+'T'+String(config.start_hour).padStart(2,'0')+':00')+i*config.interval_minutes*60000;
        if (at<now || i>=Math.floor(1440/config.interval_minutes)) continue;
        this.enqueue({source:'daily:'+day+':'+assets[i].hash, file:assets[i].file,due:at});
      }
    }
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      this.plan();
      if (this.db.prepare("SELECT 1 FROM status_jobs WHERE state='UNKNOWN' LIMIT 1").get()) return;
      const row = this.db.prepare("SELECT * FROM status_jobs WHERE state IN ('QUEUED','WAITING') AND due<=? ORDER BY due LIMIT 1").get(this.clock()); if (!row) return;
      let session;
      try { session=await this.backend('/api/sessions/default'); }
      catch (error) { this.db.prepare("UPDATE status_jobs SET state='WAITING',error=?,updated=? WHERE id=?").run('Conexão indisponível; nova verificação automática',this.clock(),row.id); return; }
      const number=session.me?.id?.split('@')[0];
      if (session.status!=='WORKING' || !this.expectedNumber || number!==this.expectedNumber) { this.db.prepare("UPDATE status_jobs SET state='WAITING',error=?,updated=? WHERE id=?").run('Aguardando conexão da conta configurada',this.clock(),row.id); return; }
      let asset; let id=row.message_id;
      try { asset=this.readAsset(row.namespace,row.file,true); if(asset.hash!==row.hash)throw new Error('Vídeo alterado depois do agendamento'); if(!id)id=(await this.backend('/api/default/status/new-message-id')).id; if(typeof id!=='string'||!id)throw new Error('Sem identificador de envio'); }
      catch(error){this.db.prepare("UPDATE status_jobs SET state='FAILED',error=?,updated=? WHERE id=?").run(error.message,this.clock(),row.id);return;}
      this.db.prepare("UPDATE status_jobs SET state='SENDING',message_id=?,error=NULL,updated=? WHERE id=?").run(id,this.clock(),row.id);
      try {
        const result=await this.backend('/api/default/status/video','POST',{id:id,file:{mimetype:'video/mp4',filename:asset.name,data:asset.data.toString('base64')},caption:row.caption,convert:false},600000);
        if(!result?.id)throw new Error('Resposta sem confirmação do identificador');
        this.db.prepare("UPDATE status_jobs SET state='SENT',message_id=?,updated=? WHERE id=?").run(result.id,this.clock(),row.id);
      }catch(error){this.db.prepare("UPDATE status_jobs SET state='UNKNOWN',error=?,updated=? WHERE id=?").run('Servidor não confirmou o resultado. Verifique Meu status no celular antes de reenviar.',this.clock(),row.id);}
    } finally { this.busy=false; }
  }
}
