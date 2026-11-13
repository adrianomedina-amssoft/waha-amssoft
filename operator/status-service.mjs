import { createRequire } from 'node:module';
import { openSync, closeSync, readSync, realpathSync, lstatSync, fstatSync, constants } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
export class StatusService {
  constructor({ filename, directories, backend, expectedNumber, token, clock = Date.now }) {
    this.db = new Database(filename); this.db.pragma('foreign_keys = ON'); this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS status_jobs(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,namespace TEXT NOT NULL,file TEXT NOT NULL,hash TEXT NOT NULL,caption TEXT NOT NULL,due INTEGER NOT NULL,state TEXT NOT NULL,message_id TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      `);
    this.db.prepare("UPDATE status_jobs SET state='UNKNOWN',error='Serviço reiniciado durante envio; verificar no celular' WHERE state='SENDING'").run();
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
  enqueue(request) {
    const { source, file, caption = '' } = request;
    if (Object.keys(request).some(function unsupported(key) { return !['source','file','caption'].includes(key); })) throw new Error('A ponte aceita apenas envio imediato solicitado pelo Postiz');
    if (typeof source !== 'string' || !/^postiz:[a-zA-Z0-9_.-]{1,160}$/.test(source) || typeof caption !== 'string' || caption.length > 1024) throw new Error('Solicitação do Postiz inválida');
    const asset = this.readAsset('postiz', file);
    const previous = this.db.prepare('SELECT * FROM status_jobs WHERE source=?').get(source);
    if (previous) {
      if (previous.hash !== asset.hash || previous.caption !== caption) throw new Error('Chave já utilizada por outra solicitação');
      return this.publicJob(previous);
    }
    const namespace = 'postiz'; const due = this.clock();
    const id = randomUUID(); const now = this.clock();
    this.db.prepare('INSERT INTO status_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, source, namespace, asset.file, asset.hash, caption, due, 'QUEUED', null, null, now, now);
    return this.job(id);
  }
  publicJob(row) { if (!row) return null; return { id: row.id, source: row.source, file: row.file, receivedAt: row.created, state: row.state, messageId: row.message_id, error: row.error, updated: row.updated }; }
  job(id) { return this.publicJob(this.db.prepare('SELECT * FROM status_jobs WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM status_jobs ORDER BY due DESC LIMIT 150').all().map(this.publicJob); }
  resolveUnknown(id, action) {
    if (!['confirmed','not-sent'].includes(action)) throw new Error('Ação inválida');
    const row = this.db.prepare('SELECT * FROM status_jobs WHERE id=?').get(id); if (!row || row.state !== 'UNKNOWN') throw new Error('Envio não está pendente de confirmação');
    this.db.prepare('UPDATE status_jobs SET state=?,error=?,updated=? WHERE id=?').run(action === 'confirmed' ? 'CONFIRMED' : 'FAILED',action === 'confirmed' ? 'Confirmado pelo proprietário no celular' : 'Proprietário informou que não foi publicado; reenvio exige nova ação',this.clock(),id);
    return this.job(id);
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (this.db.prepare("SELECT 1 FROM status_jobs WHERE state='UNKNOWN' LIMIT 1").get()) return;
      const row = this.db.prepare("SELECT * FROM status_jobs WHERE state IN ('QUEUED','WAITING') AND source LIKE 'postiz:%' ORDER BY due LIMIT 1").get(); if (!row) return;
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
