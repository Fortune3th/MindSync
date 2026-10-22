import assert from 'node:assert/strict';
import {Api} from '../../src/api';
import {SyncEngine} from '../../src/engine';
import {emptyState} from '../../src/types';
import {MemoryLocal, string} from '../../tests/helpers';
const url = process.env.MINDSYNC_TEST_URL ?? `http://127.0.0.1:${process.env.MINDSYNC_PORT ?? '18080'}`;
assert(['127.0.0.1','localhost'].includes(new URL(url).hostname),'Integration tests only run against a disposable loopback service');
const token = process.env.MINDSYNC_ADMIN_SESSION;
const email=process.env.MINDSYNC_ADMIN_EMAIL,password=process.env.MINDSYNC_ADMIN_PASSWORD;
assert(token||(email&&password),'Provide MINDSYNC_ADMIN_SESSION or MINDSYNC_ADMIN_EMAIL and MINDSYNC_ADMIN_PASSWORD');
function api(credential: string, lose = {next: false}) {
  return new Api(async(method,path,body)=>{
    const response=await fetch(url+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body.slice().buffer:body});
    const bytes=await response.arrayBuffer();
    if(lose.next && path==='/v1/operations' && response.ok){lose.next=false;throw new Error('simulated response loss');}
    return {status:response.status,body:bytes};
  });
}
const credential=token??(await api('').login(email!,password!)).session_token;
const admin=api(credential),tag=crypto.randomUUID().slice(0,8);
try {
const mac=await admin.register(`integration-mac-${tag}`),android=await admin.register(`integration-android-${tag}`);
const a=new MemoryLocal(),b=new MemoryLocal(),loss={next:false};
const A=new SyncEngine(emptyState(),a,api(mac.token,loss),'mac'),B=new SyncEngine(emptyState(),b,api(android.token),'android');
await A.sync();await B.sync();
const path=`integration-${tag}/note.md`;
a.set(path,'mac first');await A.sync();await B.sync();assert.equal(string(await b.read(path)),'mac first');
console.log('PASS real HTTP note upload/download');
const attachment=`integration-${tag}/attachment.bin`,binary=Uint8Array.from([0,255,1,128,42]);
a.files.set(attachment,binary);await A.sync();await B.sync();assert.deepEqual(await b.read(attachment),binary);
console.log('PASS real HTTP binary attachment checksum/transfer');
a.set(path,'mac offline');b.set(path,'android offline');await A.sync();await B.sync();await A.sync();assert([...a.files.values()].map(string).includes('android offline'));assert.equal(string(await b.read(path)),'mac offline');
console.log('PASS concurrent edit conflict copies');
const renamed=`integration-${tag}/renamed.md`;a.files.set(renamed,a.files.get(path)!);a.files.delete(path);await A.renamed(path,renamed);await A.sync();await B.sync();assert.equal(await b.read(path),null);assert.equal(string(await b.read(renamed)),'mac offline');
console.log('PASS stable-ID rename');
const folder=`integration-${tag}/Notes`,targetFolder=`integration-${tag}/notes`;
a.set(`${folder}/a.md`,'directory A');a.set(`${folder}/b.md`,'directory B');await A.sync();await B.sync();
const directoryIds=Object.values(A.state.files).filter(f=>f.path.startsWith(folder+'/')).map(f=>f.id).sort();
for(const name of ['a.md','b.md']){a.files.set(`${targetFolder}/${name}`,a.files.get(`${folder}/${name}`)!);a.files.delete(`${folder}/${name}`);await A.renamed(`${folder}/${name}`,`${targetFolder}/${name}`);}
await A.sync();await B.sync();assert.equal(string(await b.read(`${targetFolder}/a.md`)),'directory A');assert.equal(string(await b.read(`${targetFolder}/b.md`)),'directory B');
assert.deepEqual(Object.values(A.state.files).filter(f=>f.path.startsWith(targetFolder+'/')).map(f=>f.id).sort(),directoryIds);
console.log('PASS multi-file directory casing rename across real PostgreSQL path constraints');
a.files.delete(renamed);b.set(renamed,'edit versus delete');await A.sync();await B.sync();await A.sync();assert.equal(await b.read(renamed),null);assert([...a.files.values()].map(string).includes('edit versus delete'));
console.log('PASS delete propagation with offline edit protection');
const retryPath=`integration-${tag}/retry.md`;a.set(retryPath,'durable response');loss.next=true;await assert.rejects(A.sync(),/simulated response loss/);assert(a.saved.pending.length);const restarted=new SyncEngine(structuredClone(a.saved),a,api(mac.token),'mac');await restarted.sync();await B.sync();assert.equal(string(await b.read(retryPath)),'durable response');const record=Object.values(restarted.state.files).find(f=>f.path===retryPath)!;assert.equal((await api(mac.token).history(record.id)).versions.length,1);
console.log('PASS response-loss recovery after client restart (one committed revision)');
const original=(await api(mac.token).history(record.id)).versions[0];
a.set(retryPath,'new current content');await restarted.sync();await restarted.restore(record.id,original);await B.sync();
assert.equal(string(await b.read(retryPath)),'durable response');assert.equal((await api(mac.token).history(record.id)).versions.length,3);
assert([...a.files.values()].map(string).includes('new current content'));
console.log('PASS same-identity history restore creates new revision and preserves current bytes');
const active=await api(mac.token).snapshot();assert(active.files.some(f=>f.deleted));
await admin.revoke(android.id);await assert.rejects(api(android.token).info(),e=>e instanceof Error && 'code' in e && e.code==='UNAUTHORIZED');
console.log('PASS device token revocation');
await admin.revoke(mac.id);
console.log('All real HTTP integration scenarios passed');

} finally {if(!token)await admin.logout();}
