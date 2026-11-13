import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOperator } from './server.mjs';
test('bridge exposes no publishing or scheduling routes even for enrolled operator', async function boundaries() {
  const received=[];
  const auth={api:{getSession:async function session(){return {user:{id:'fixture',twoFactorEnabled:true},session:{operatorMfa:true}};}}};
  const service={list:function list(){return [];},authenticate:function authenticate(value){return value==='Bearer fixture-key';},enqueue:function enqueue(request){received.push(request);return{id:'fixture-job',state:'QUEUED'};}};
  const app=await createOperator({auth:auth,administratorId:'fixture',origin:'http://localhost:8080',statusService:service});
  const server=app.listen(0,'127.0.0.1');await new Promise(function ready(resolve){server.once('listening',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  async function post(path,body){return fetch(base+path,{method:'POST',headers:{Origin:'http://localhost:8080','Content-Type':'application/json',Authorization:'Bearer fixture-key'},body:JSON.stringify(body)});}
  try {
    for(const path of ['/status/jobs','/status/config'])assert.equal((await post(path,{})).status,404);
    const summary=await(await fetch(base+'/status')).json();assert.deepEqual(Object.keys(summary).sort(),['jobs','timezone']);
    for(const field of ['due','dueLocal','scheduledAt','interval_minutes'])assert.equal((await post('/automation/jobs',{id:'fixture-id',file:'fixture.mp4',[field]:'future'})).status,400);
    assert.equal(received.length,0);
    assert.equal((await post('/automation/jobs',{id:'fixture-id',file:'fixture.mp4',caption:'fixture'})).status,202);
    assert.deepEqual(received,[{source:'postiz:fixture-id',file:'fixture.mp4',caption:'fixture'}]);
    const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
    for(const id of ['schedule-video','publish-now','publish-at','daily-enabled','daily-hour','daily-interval','save-daily'])assert.equal(html.includes('id="'+id+'"'),false);
  } finally {await new Promise(function close(resolve){server.close(resolve);});}
});
