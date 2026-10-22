// Genuine process kills and ObsidianLocal journal recovery, with a disk-backed
// headless Vault adapter. This does not establish actual Obsidian UI behavior.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,statSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {App,TFile,TFolder} from 'obsidian';
import {Api} from '../../src/api';
import {SyncEngine} from '../../src/engine';
import {ObsidianLocal} from '../../src/local';
import {digest} from '../../src/types';
import {sample} from '../../tests/helpers';
const base=process.env.MINDSYNC_TEST_URL??'http://127.0.0.1:18083';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Disposable loopback library required');
const mode=process.argv[2],root=process.argv[3];
interface Report {event:string;bytes:number;hashes:string[];hash?:string;revision?:number}
function diskLocal(directory:string) {
  const full=(path:string)=>join(directory,path);
  const file=(path:string)=>{const f=new TFile();f.path=path;return f;};
  const app={vault:{
    adapter:{exists:async(path:string)=>existsSync(full(path)),read:async(path:string)=>(await readFile(full(path))).toString(),write:async(path:string,value:string)=>{await writeFile(full(path),value);}},
    getFiles:()=>existsSync(full('payload.bin'))?[file('payload.bin')]:[],
    getAllLoadedFiles:()=>[],
    getAbstractFileByPath:(path:string)=>{if(!existsSync(full(path)))return null;if(statSync(full(path)).isDirectory()){const f=new TFolder();f.path=path;return f;}return file(path);},
    readBinary:async(f:TFile)=>{const bytes=await readFile(full(f.path));return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);},
    createFolder:async(path:string)=>{await mkdir(full(path));},
    createBinary:async(path:string,bytes:ArrayBuffer)=>{await writeFile(full(path),new Uint8Array(bytes),{flag:'wx'});return file(path);},
    trash:async(f:TFile)=>{await mkdir(full('.trash'),{recursive:true});await rename(full(f.path),full(`.trash/${crypto.randomUUID()}`));},
    rename:async(f:TFile,path:string)=>{await rename(full(f.path),full(path));f.path=path;},
  }} as unknown as App;
  return new ObsidianLocal(app,'.obsidian/plugins/mindsync');
}
if(mode) {
  const credential=process.env.MINDSYNC_DEVICE_TOKEN;assert(credential);
  let bytes=0,hashes:string[]=[];const started=Date.now();let interrupted=false;
  const report=(event:string)=>new Promise<void>(resolve=>process.send!({event,bytes,hashes},()=>resolve()));
  const waitForever=()=>new Promise<never>(()=>{});
  const remote=new Api(async(method,path,body)=>{
    if(mode==='outage' && Date.now()-started<30000 && path.startsWith('/v1/chunks/') && method==='PUT')throw new Error('simulated 30-second outage');
    const stop=(mode==='half' && bytes>=6*1024*1024 && method==='PUT' && path.startsWith('/v1/chunks/')) || (mode==='before-commit' && method==='POST' && path==='/v1/operations');
    if(stop){if(!interrupted){interrupted=true;await report('ready-to-kill');}return waitForever();}
    const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body.slice().buffer:body});
    const data=await response.arrayBuffer();
    if(response.ok && method==='PUT' && path.startsWith('/v1/chunks/')){bytes+=(body as Uint8Array).length;hashes.push(path.split('/').at(-1)!);}
    return {status:response.status,body:data};
  });
  const local=diskLocal(root),engine=new SyncEngine(await local.load(),local,remote);
  for(;;){try{await engine.sync();break;}catch(error){if(mode!=='outage')throw error;await new Promise(resolve=>setTimeout(resolve,5000));}}
  const file=Object.values(engine.state.files).find(f=>f.path==='payload.bin');assert(file);assert.equal(engine.state.pending.length,0);
  assert.equal(await digest((await local.read('payload.bin'))!),file.hash);
  await new Promise<void>(resolve=>process.send!({event:'complete',bytes,hashes,hash:file.hash,revision:file.revision},()=>resolve()));
} else {
  const adminToken=process.env.MINDSYNC_ADMIN_SESSION;assert(adminToken);
  const admin=new Api(async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'},body:body as string|undefined});return {status:r.status,body:await r.arrayBuffer()};});
  assert.equal((await admin.snapshot()).files.length,0,'Use a fresh disposable library');
  const device=await admin.register('process-acceptance');
  await mkdir('nas-data',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'nas-data/v2-process-'));
  await mkdir(join(directory,'.obsidian/plugins/mindsync'),{recursive:true});
  const run=(kind:string,kill:boolean)=>new Promise<Report>((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),kind,directory],{env:{...process.env,MINDSYNC_DEVICE_TOKEN:device.token},stdio:['ignore','inherit','inherit','ipc']});
    let result:Report|undefined;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Process acceptance timed out'));},90000);
    child.on('message',(message:Report)=>{result=message;if(kill && message.event==='ready-to-kill')child.kill('SIGKILL');});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',(code,signal)=>{clearTimeout(timer);if(result && ((kill && signal==='SIGKILL') || (!kill && code===0 && result.event==='complete')))resolve(result);else reject(new Error(`Unexpected child exit ${code}/${signal}`));});
  });
  try {
    let content=sample(10*1024*1024);await writeFile(join(directory,'payload.bin'),content);
    const stopped=await run('half',true),resumed=await run('resume',false);
    assert(resumed.bytes<content.length/2);assert(resumed.hashes.every(h=>!stopped.hashes.includes(h)));assert.equal(resumed.hash,await digest(content));
    console.log(`PASS SIGKILL with real state slots: ${stopped.bytes} bytes acknowledged, ${resumed.bytes} bytes resumed`);
    content=content.slice();content[500000]^=255;await writeFile(join(directory,'payload.bin'),content);
    await run('before-commit',true);const committed=await run('resume',false);assert.equal(committed.bytes,0);assert.equal(committed.hash,await digest(content));
    console.log('PASS SIGKILL before commit: zero repeated PUTs');
    content=content.slice();content[1500000]^=255;await writeFile(join(directory,'payload.bin'),content);
    const started=Date.now(),recovered=await run('outage',false);assert(Date.now()-started>=30000);assert.equal(recovered.hash,await digest(content));
    console.log(`PASS automatic retry after 30-second simulated outage: ${Date.now()-started} ms`);
    await writeFile('nas-data/process-acceptance.json',JSON.stringify({acknowledged_bytes:stopped.bytes,resumed_bytes:resumed.bytes,before_commit_resumed_bytes:committed.bytes,outage_elapsed_ms:Date.now()-started,hash:recovered.hash},null,2));
  } finally {await rm(directory,{recursive:true,force:true});}
}
