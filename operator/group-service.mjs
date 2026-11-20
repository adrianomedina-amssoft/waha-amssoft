import { createRequire } from 'node:module';
import { openSync, closeSync, readSync, realpathSync, lstatSync, fstatSync, constants } from 'node:fs';
import { resolve, relative, sep, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
export class GroupService {
  constructor({ filename, directory, backend, expectedNumber, groups = [], clock = Date.now }) {
    this.db = new Database(filename); this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS group_jobs(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,file TEXT NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,caption TEXT NOT NULL,targets TEXT NOT NULL,received INTEGER NOT NULL,updated INTEGER NOT NULL,state TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS group_deliveries(job_id TEXT NOT NULL,group_id TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,error TEXT,updated INTEGER NOT NULL,PRIMARY KEY(job_id,group_id));`);
    this.directory = directory; this.backend = backend; this.expectedNumber = expectedNumber; this.clock = clock; this.busy = false;
    this.groups = new Map(groups.filter(function valid(g) { return /^[0-9-]+@g\.us$/.test(g.id) && typeof g.title === 'string'; }).map(function entry(g) { return [g.id,g.title]; }));
    this.db.prepare("UPDATE group_deliveries SET state='UNKNOWN',error='Processo reiniciado durante envio; conferir no grupo' WHERE state='SENDING'").run();
    for (const row of this.db.prepare("SELECT id FROM group_jobs WHERE state IN ('SENDING','WAITING','QUEUED')").all()) this.refresh(row.id);
  }
  catalog() { return [...this.groups].map(function group([id,title]) { return { id: id, title: title }; }); }
  media(file, content = false) {
    if (typeof file !== 'string' || !file || file.length > 1024 || file.includes('\0')) throw new Error('Arquivo inválido');
    const root = realpathSync(this.directory); const target = resolve(root,file); const rel = relative(root,target);
    if (!rel || rel === '..' || rel.startsWith('..'+sep) || resolve(file) === file) throw new Error('Arquivo fora da biblioteca');
    let cursor = root; for (const part of rel.split(sep)) { cursor = resolve(cursor,part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('Links não permitidos'); }
    if (realpathSync(target) !== target) throw new Error('Arquivo inválido');
    const fd = openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd); if (!st.isFile() || st.size <= 0 || st.size > 32*1024*1024) throw new Error('Mídia deve ter até 32 MiB');
      const data = Buffer.alloc(st.size); let offset = 0; while (offset < data.length) { const n = readSync(fd,data,offset,data.length-offset,offset); if (!n) break; offset += n; }
      const after = fstatSync(fd); if (offset !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error('Arquivo em alteração');
      const extension = extname(target).toLowerCase(); let mime;
      if (extension === '.mp4' && data.subarray(0,64).includes(Buffer.from('ftyp'))) mime = 'video/mp4';
      else if (['.jpg','.jpeg'].includes(extension) && data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg';
      else if (extension === '.png' && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
      else throw new Error('Use MP4, JPEG ou PNG válido');
      return { file: rel, name: basename(rel), mime: mime, hash: createHash('sha256').update(data).digest('hex'), ...(content ? { data: data } : {}) };
    } finally { closeSync(fd); }
  }
  enqueue(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(function unknown(k) { return !['id','file','caption','groupIds'].includes(k); }) || typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id) || typeof body.file !== 'string' || (body.caption !== undefined && typeof body.caption !== 'string') || (body.caption || '').length > 1024) throw new Error('Pedido de grupo inválido; o horário pertence ao Postiz');
    const targets = body.groupIds === undefined ? [...this.groups.keys()] : body.groupIds;
    if (!Array.isArray(targets) || !targets.length || targets.length > 1000 || targets.some(id=>typeof id !== 'string' || !this.groups.has(id)) || new Set(targets).size !== targets.length) throw new Error('Grupo não autorizado');
    const encoded = JSON.stringify([...targets].sort()); const caption = body.caption || '';
    const prior = this.db.prepare('SELECT * FROM group_jobs WHERE source=?').get(body.id);
    if (prior) { if (prior.file !== body.file || prior.caption !== caption || prior.targets !== encoded) throw new Error('Identidade já utilizada por outra solicitação'); return this.job(prior.id); }
    const media = this.media(body.file); const id = randomUUID(); const now = this.clock();
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO group_jobs VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,body.id,media.file,media.hash,media.mime,caption,encoded,now,now,'QUEUED');
      const insert = this.db.prepare("INSERT INTO group_deliveries VALUES(?,?,'QUEUED',NULL,NULL,?)"); for (const target of targets) insert.run(id,target,now);
    })(); return this.job(id);
  }
  refresh(id) {
    const counts = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM group_deliveries WHERE job_id=? GROUP BY state').all(id).map(r=>[r.state,r.n]));
    const state = (counts.QUEUED || counts.SENDING) ? 'SENDING' : counts.UNKNOWN ? 'UNKNOWN' : counts.FAILED ? 'FAILED' : 'SENT';
    this.db.prepare('UPDATE group_jobs SET state=?,updated=?,error=? WHERE id=?').run(state,this.clock(),state==='FAILED'?'Alguns grupos não receberam. Consulte o histórico; não repita os envios já confirmados.':state==='UNKNOWN'?'Há resultado sem confirmação; conferir os grupos indicados.':null,id);
  }
  job(id) {
    const row = this.db.prepare('SELECT * FROM group_jobs WHERE id=?').get(id); if (!row) return null;
    const deliveries = this.db.prepare('SELECT group_id,state,error FROM group_deliveries WHERE job_id=?').all(id);
    return { id: row.id, kind: 'groups', file: row.file, receivedAt: row.received, updated: row.updated, state: row.state, error: row.error, messageId: row.id,
      summary: { total: deliveries.length, sent: deliveries.filter(d=>['SENT','CONFIRMED'].includes(d.state)).length, failed: deliveries.filter(d=>d.state==='FAILED').length, unknown: deliveries.filter(d=>d.state==='UNKNOWN').length },
      deliveries: deliveries.map(d=>({groupId:d.group_id,title:this.groups.get(d.group_id)||'Grupo autorizado',state:d.state,error:d.error})) };
  }
  list() { return this.db.prepare('SELECT id FROM group_jobs ORDER BY received DESC LIMIT 20').all().map(r=>this.job(r.id)); }
  resolve(id,groupId,action) {
    if (!['confirmed','not-sent'].includes(action)) throw new Error('Ação inválida');
    const result = this.db.prepare("UPDATE group_deliveries SET state=?,error=?,updated=? WHERE job_id=? AND group_id=? AND state='UNKNOWN'").run(action==='confirmed'?'CONFIRMED':'FAILED',action==='confirmed'?'Confirmado pelo operador':'Operador informou que não foi publicado',this.clock(),id,groupId);
    if (!result.changes) throw new Error('Entrega não está pendente de confirmação'); this.refresh(id); return this.job(id);
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const row = this.db.prepare("SELECT * FROM group_jobs WHERE state IN ('QUEUED','WAITING','SENDING') ORDER BY received LIMIT 1").get(); if (!row) return;
      const delivery = this.db.prepare("SELECT * FROM group_deliveries WHERE job_id=? AND state='QUEUED' ORDER BY rowid LIMIT 1").get(row.id); if (!delivery) { this.refresh(row.id); return; }
      if (this.clock()-row.received > 90*60000) { this.db.prepare("UPDATE group_deliveries SET state='FAILED',error='Prazo de envio encerrado antes do despacho',updated=? WHERE job_id=? AND state='QUEUED'").run(this.clock(),row.id); this.refresh(row.id); return; }
      let session; try { session = await this.backend('/api/sessions/default'); } catch { session = null; }
      if (session?.status !== 'WORKING' || session.me?.id?.split('@')[0] !== this.expectedNumber) { this.db.prepare("UPDATE group_jobs SET state='WAITING',updated=? WHERE id=?").run(this.clock(),row.id); return; }
      let media; let messageId;
      try { if (!this.groups.has(delivery.group_id)) throw new Error('Grupo não autorizado'); media=this.media(row.file,true); if (media.hash!==row.hash) throw new Error('Mídia alterada após o pedido'); messageId=(await this.backend('/api/default/new-message-id')).id; if(typeof messageId!=='string'||!messageId)throw new Error('Sem identificador de envio'); }
      catch(error){this.db.prepare("UPDATE group_deliveries SET state='FAILED',error=?,updated=? WHERE job_id=? AND group_id=?").run(error.message,this.clock(),row.id,delivery.group_id);this.refresh(row.id);return;}
      this.db.prepare("UPDATE group_deliveries SET state='SENDING',message_id=?,updated=? WHERE job_id=? AND group_id=?").run(messageId,this.clock(),row.id,delivery.group_id);
      this.db.prepare("UPDATE group_jobs SET state='SENDING' WHERE id=?").run(row.id);
      try { const result=await this.backend(media.mime==='video/mp4'?'/api/sendVideo':'/api/sendImage','POST',{session:'default',chatId:delivery.group_id,id:messageId,file:{mimetype:media.mime,filename:media.name,data:media.data.toString('base64')},caption:row.caption,convert:false},120000);if(!result?.id)throw Error('Sem confirmação');this.db.prepare("UPDATE group_deliveries SET state='SENT',message_id=?,updated=? WHERE job_id=? AND group_id=?").run(typeof result.id==='string'?result.id:JSON.stringify(result.id),this.clock(),row.id,delivery.group_id); }
      catch{this.db.prepare("UPDATE group_deliveries SET state='UNKNOWN',error='Conferir envio neste grupo antes de repetir',updated=? WHERE job_id=? AND group_id=?").run(this.clock(),row.id,delivery.group_id);}
      this.refresh(row.id);
    } finally { this.busy=false; }
  }
}
