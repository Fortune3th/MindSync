// Real HTTP and disk-journal acceptance. Use only a fresh disposable loopback library.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,stat,rename,rm,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DataAdapter} from 'obsidian';
import {Api} from '../../src/api';
import {ConfigurationLocal} from '../../src/configuration-local';
import {ConfigurationSync} from '../../src/configuration-sync';
import {defaultConfigurationSelection} from '../../src/configuration-paths';
import {SyncEngine} from '../../src/engine';
import {digest,emptyState,SyncError} from '../../src/types';
import {MemoryLocal} from '../../tests/helpers';

function disk(root:string,afterProcess?:(path:string)=>Promise<void>) {
  const full=(path:string)=>{const absolute=resolve(root,path);assert(absolute.startsWith(resolve(root)+'/'));return absolute;};
  return {
    exists:async(path:string)=>{try{await stat(full(path));return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
    mkdir:async(path:string)=>{await mkdir(full(path));},
    read:async(path:string)=>readFile(full(path),'utf8'),
    readBinary:async(path:string)=>{const b=await readFile(full(path));return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);},
    write:async(path:string,value:string)=>{await writeFile(full(path),value);},
    writeBinary:async(path:string,value:ArrayBuffer)=>{await writeFile(full(path),new Uint8Array(value));},
    list:async(path:string)=>{const entries=await readdir(full(path),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>path+'/'+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>path+'/'+e.name)};},
    process:async(path:string,change:(value:string)=>string)=>{const after=change(await readFile(full(path),'utf8'));await writeFile(full(path),after);await afterProcess?.(path);return after;},
    remove:async(path:string)=>{await rm(full(path));},
    rename:async(from:string,to:string)=>{await rename(full(from),full(to));},
  } as unknown as DataAdapter;
}
const childMode=process.argv[2],childRoot=process.argv[3];
if(childMode==='kill-apply') {
  process.on('message',()=>{});
  const adapter=disk(childRoot,async path=>{
    if(path==='.obsidian/app.json'){
      await new Promise<void>(done=>process.send!('ready-to-kill',()=>done()));
      await new Promise<never>(()=>{});
    }
  });
  const local=new ConfigurationLocal(adapter,'.obsidian','.obsidian/plugins/mindsync/configuration-sync');await local.load();
  await local.apply([
    {path:'app.json',bytes:new TextEncoder().encode('{"after":true}'),expectedHash:await local.hash('app.json')},
    {path:'hotkeys.json',bytes:new TextEncoder().encode('{"after":true}'),expectedHash:await local.hash('hotkeys.json')},
  ]);
}else{
  const base=process.env.MINDSYNC_TEST_URL??'http://127.0.0.1:18087',adminToken=process.env.MINDSYNC_ADMIN_SESSION;
  assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));assert(adminToken);
  let loseReply=false,uploads=0;
  const api=(token:string,scope:'notes'|'configuration'='notes')=>new Api(async(method,path,body)=>{
    const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body.slice().buffer:body});
    const data=await r.arrayBuffer();
    if(r.ok&&method==='PUT')uploads++;
    if(r.ok&&loseReply&&method==='POST'&&path==='/v1/configuration/operations'){loseReply=false;throw new Error('lost committed configuration reply');}
    return {status:r.status,body:data};
  },scope);
  const admin=api(adminToken);assert.equal((await admin.info()).configuration_sync,true);assert.equal((await admin.snapshot()).files.length,0);
  const source=await admin.register('configuration-source'),target=await admin.register('configuration-target');
  await mkdir('nas-data',{recursive:true});const root=await mkdtemp(join(process.cwd(),'nas-data/configuration-http-'));
  const roots=[join(root,'source'),join(root,'target')];for(const r of roots)await mkdir(r);
  const adapters=roots.map(r=>disk(r)),locals=adapters.map((a,i)=>new ConfigurationLocal(a,i===0?'.obsidian':'custom-config',(i===0?'.obsidian':'custom-config')+'/plugins/mindsync/configuration-sync'));
  const selection=defaultConfigurationSelection();selection.enabled=true;selection.plugins.example={files:true,settings:true};selection.themes=['Example'];selection.snippets=['custom.css'];
  const A=new ConfigurationSync(locals[0],api(source.token,'configuration'),()=>selection),B=new ConfigurationSync(locals[1],api(target.token,'configuration'),()=>structuredClone(selection));
  const set=async(index:number,path:string,value:string)=>{const physical=(index===0?'.obsidian/':'custom-config/')+path;await locals[index].parents(physical);await adapters[index].write(physical,value);};
  try{
    const note=new MemoryLocal();note.set('app.json','ordinary note content');await new SyncEngine(emptyState(),note,api(source.token)).sync();
    const files={
      'app.json':'{"spellcheck":true}',
      'snippets/custom.css':'body { color: red; }',
      'themes/Example/manifest.json':'{"name":"Example","version":"1.0.0"}',
      'themes/Example/theme.css':'body { background: white; }',
      'plugins/example/manifest.json':JSON.stringify({id:'example',name:'Example',version:'1.0.0',minAppVersion:'1.8.0',description:'Acceptance fixture',author:'MindSync'}),
      'plugins/example/main.js':'// MindSync configuration fixture\n'.repeat(10000)+'module.exports = class Example {};',
      'plugins/example/styles.css':'.example { display: block; }',
      'plugins/example/data.json':'{"format":"short"}',
    };
    for(const [path,value] of Object.entries(files))await set(0,path,value);
    await set(0,'workspace.json','{"device":"private"}');await set(0,'plugins/mindsync/data.json','{"token":"fixture-only-secret"}');
    await locals[0].load();await locals[1].load();await A.publish(await A.previewPublish());
    const updates=await B.review();assert.equal(updates.length,Object.keys(files).length);assert.equal(await locals[1].read('app.json'),null);
    await set(1,'app.json','{"local":"edited after preview"}');await assert.rejects(B.apply(updates),e=>e instanceof SyncError&&e.code==='LOCAL_CHANGED');
    const refreshed=await B.review();await B.apply(refreshed);
    for(const [path,value] of Object.entries(files))assert.equal(await digest((await locals[1].read(path))!),await digest(new TextEncoder().encode(value)));
    const notes=await api(target.token).snapshot(),configuration=await api(target.token,'configuration').snapshot();
    assert.equal(notes.files.length,1);assert.equal(notes.files[0].path,'app.json');assert.equal(configuration.files.length,Object.keys(files).length);
    assert(!configuration.files.some(f=>/workspace|mindsync\//.test(f.path)));
    console.log(`PASS real HTTP configuration round trip: ${updates.length} selected files, custom configDir, note/configuration isolation, stale preview and private exclusions`);
    await set(0,'app.json','{"spellcheck":false}');loseReply=true;await assert.rejects(A.publish(await A.previewPublish()),/lost committed/);const before=uploads;
    const restarted=new ConfigurationLocal(adapters[0],'.obsidian',locals[0].directory);await restarted.load();await new ConfigurationSync(restarted,api(source.token,'configuration'),()=>selection).review();assert.equal(uploads,before);assert.equal(restarted.state.pending.length,0);
    console.log('PASS configuration receipt recovery after disk-journal restart: zero repeated PUTs');
    const killRoot=join(root,'kill');await mkdir(join(killRoot,'.obsidian'),{recursive:true});await writeFile(join(killRoot,'.obsidian/app.json'),'{}');await writeFile(join(killRoot,'.obsidian/hotkeys.json'),'{}');
    await new Promise<void>((done,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'kill-apply',killRoot],{stdio:['ignore','inherit','inherit','ipc']});let ready=false;
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Configuration SIGKILL deadline exceeded'));},30000);
      child.on('message',message=>{if(message==='ready-to-kill'){ready=true;child.kill('SIGKILL');}});
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',(_code,signal)=>{clearTimeout(timer);if(ready&&signal==='SIGKILL')done();else reject(new Error(`Unexpected child exit: ${signal}`));});
    });
    assert.equal(await readFile(join(killRoot,'.obsidian/app.json'),'utf8'),'{"after":true}');
    const recovered=new ConfigurationLocal(disk(killRoot),'.obsidian','.obsidian/plugins/mindsync/configuration-sync');await recovered.load();assert.equal(await readFile(join(killRoot,'.obsidian/app.json'),'utf8'),'{}');assert.equal(await readFile(join(killRoot,'.obsidian/hotkeys.json'),'utf8'),'{}');assert.equal(recovered.state.intent,undefined);
    console.log('PASS actual SIGKILL during grouped configuration application: original files recovered from the disk journal');
    await writeFile('nas-data/configuration-acceptance.json',JSON.stringify({selected_files:updates.length,scope_isolation:true,private_files_excluded:true,stale_preview_rejected:true,receipt_repeated_puts:uploads-before,group_sigkill_recovery:true},null,2));
  }finally{await rm(root,{recursive:true,force:true});}
}
