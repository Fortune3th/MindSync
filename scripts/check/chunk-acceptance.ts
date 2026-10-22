// Run only after compiling against a fresh disposable local v2 service.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Api} from '../../src/api';
import {SyncEngine} from '../../src/engine';
import {digest,emptyState} from '../../src/types';
import {MemoryLocal,sample} from '../../tests/helpers';
const base=process.env.MINDSYNC_TEST_URL??'http://127.0.0.1:18080',token=process.env.MINDSYNC_ADMIN_SESSION;
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Requires a disposable loopback service');assert(token,'MINDSYNC_ADMIN_SESSION required');
interface Transfer {bytes:number;hashes:string[];stopAfter?:number;blockCommit?:boolean}
const transfer:Transfer={bytes:0,hashes:[]};
const api=(credential:string)=>new Api(async(method,path,body)=>{
  if(method==='PUT' && path.startsWith('/v1/chunks/') && transfer.stopAfter!==undefined && transfer.bytes>=transfer.stopAfter)throw new Error('simulated interruption');
  if(method==='POST' && path==='/v1/operations' && transfer.blockCommit)throw new Error('stopped before commit');
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body.slice().buffer:body});
  const data=await response.arrayBuffer();
  if(response.ok && method==='PUT' && path.startsWith('/v1/chunks/')){transfer.bytes+=(body as Uint8Array).length;transfer.hashes.push(path.split('/').at(-1)!);}
  return {status:response.status,body:data};
});
const admin=api(token);assert.equal((await admin.info()).protocol,2);assert.equal((await admin.snapshot()).files.length,0,'Use a fresh disposable library');
const device=await admin.register('chunk-acceptance'),remote=api(device.token),local=new MemoryLocal();let engine=new SyncEngine(emptyState(),local,remote);
const bytes=sample(2*1024*1024);local.files.set('one.bin',bytes);await engine.sync();
const count=transfer.hashes.length;local.files.set('two.bin',bytes);await engine.sync();assert.equal(transfer.hashes.length,count);console.log('PASS repeated 2 MiB content: zero additional chunk PUTs');
const receiver=new MemoryLocal();await new SyncEngine(emptyState(),receiver,remote).sync();assert.equal(await digest((await receiver.read('two.bin'))!),await digest(bytes));
const large=sample(10*1024*1024),start=transfer.bytes;transfer.stopAfter=start+large.length*0.6;local.files.set('large.bin',large);
await assert.rejects(()=>engine.sync(),/simulated interruption/);const prior=new Set(transfer.hashes),offset=transfer.hashes.length,before=transfer.bytes;
transfer.stopAfter=undefined;engine=new SyncEngine(structuredClone(local.saved),local,remote);await engine.sync();
assert(transfer.hashes.slice(offset).every(hash=>!prior.has(hash)));assert(transfer.bytes-before<large.length/2);
await new SyncEngine(emptyState(),receiver,remote).sync(true);assert.equal(await digest((await receiver.read('large.bin'))!),await digest(large));console.log(`PASS 10 MiB restart: ${transfer.bytes-before} resumed bytes`);
local.files.set('before-commit.bin',sample(2000000));transfer.blockCommit=true;await assert.rejects(()=>engine.sync(),/stopped before commit/);const committedCount=transfer.hashes.length;
transfer.blockCommit=false;engine=new SyncEngine(structuredClone(local.saved),local,remote);await engine.sync();assert.equal(transfer.hashes.length,committedCount);console.log('PASS restart before commit: zero repeated PUTs');
const baseline=await admin.info();
const pdfPath=process.env.MINDSYNC_TEST_PDF;
const original=pdfPath?new Uint8Array(await readFile(pdfPath)):sample(2*1024*1024).map(b=>(b+17)&255);
if(pdfPath)assert.equal(new TextDecoder().decode(original.subarray(0,5)),'%PDF-','MINDSYNC_TEST_PDF must be a PDF');
assert(original.length>=65536,'Deduplication fixture must exceed the small-file threshold');
for(let version=0;version<3;version++){
  let content:Uint8Array;
  if(pdfPath){const comment=new TextEncoder().encode(`\n% MindSync acceptance version ${version}\n`);content=new Uint8Array(original.length+comment.length);content.set(original);content.set(comment,original.length);}
  else {content=original.slice();content[Math.floor(content.length/2)]=version;}
  local.files.set(pdfPath?'versions.pdf':'versions.bin',content);await engine.sync();
}
const after=await admin.info(),physical=after.storage_bytes-baseline.storage_bytes,logical=after.logical_bytes!-baseline.logical_bytes!,ratio=physical/logical;
assert(ratio<0.7,`Expected substantial reuse, got ${ratio}`);console.log(JSON.stringify({fixture:pdfPath?'PDF with trailing version comments':'synthetic binary',storage_delta:physical,logical_delta:logical,ratio},null,2));
