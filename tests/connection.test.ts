import {test,expect} from 'vitest';
import {Api} from '../src/api';
import {ConnectionContext, ConnectedHttp} from '../src/connection';
import {SyncEngine} from '../src/engine';
import {emptyState, Operation} from '../src/types';
import {MemoryLocal,MemoryRemote} from './helpers';
const json=(value:unknown,status=200)=>({status,body:new TextEncoder().encode(JSON.stringify(value)).buffer});
function setup() {
  const settings={server:'https://a.example',token:'a-token'};
  const a=new MemoryRemote(),b=new MemoryRemote(),local=new MemoryLocal(),connection=new ConnectionContext(()=>settings);
  a.info=async()=>({protocol:1,vault_id:'vault-a',max_file_bytes:1048576,cursor:a.log.length,storage_bytes:0});
  b.info=async()=>({protocol:1,vault_id:'vault-b',max_file_bytes:1048576,cursor:b.log.length,storage_bytes:0});
  const calls:{server:string;token:string;path:string}[]=[];
  let release:(()=>void)|undefined, started:(()=>void)|undefined;
  const send:ConnectedHttp=async(endpoint,method,path,body)=>{
    calls.push({...endpoint,path});
    const remote=endpoint.server===settingsInitial ? a : b;
    if(path==='/v1/info') {const info=await remote.info();if(started){const ready=started;started=undefined;ready();await new Promise<void>(resolve=>release=resolve);}return json(info);}
    if(path==='/v1/snapshot')return json(await remote.snapshot());
    if(path.startsWith('/v1/changes?')){const q=new URL('https://unused'+path).searchParams;return json(await remote.changes(Number(q.get('after')),q.has('until')?Number(q.get('until')):undefined));}
    if(path.startsWith('/v1/objects/')){const hash=path.slice('/v1/objects/'.length);if(method==='PUT'){await remote.upload(hash,body as Uint8Array);return json({});}return {status:200,body:(await remote.download(hash)).slice().buffer};}
    if(path==='/v1/operations')return json(await remote.apply(JSON.parse(body as string) as Operation));
    if(path.startsWith('/v1/operations/')){const result=await remote.result(path.slice('/v1/operations/'.length));return result ? json(result) : json({error:{code:'NOT_FOUND'}},404);}
    throw new Error('unexpected request '+path);
  };
  const settingsInitial=settings.server;
  const engine=new SyncEngine(emptyState(),local,new Api(connection.http(send)));
  const delayInfo=()=>new Promise<void>(resolve=>{started=resolve;});
  return {settings,a,b,local,calls,connection,engine,send,delayInfo,resume:()=>release!()};
}
test.each(['sync','preview','restore'] as const)('%s pins server and credentials across awaits then validates next connection',async operation=>{
  const s=setup();s.local.set('note.md','old');await s.connection.run(()=>s.engine.sync());const old=structuredClone(Object.values(s.engine.state.files)[0]);s.local.set('note.md','current');await s.connection.run(()=>s.engine.sync());s.calls.length=0;
  const delayed=s.delayInfo();
  const cycle=s.connection.run(async()=>{if(operation==='sync')await s.engine.sync();else if(operation==='preview')await s.engine.preview();else await s.engine.restore(old.id,old);});
  await delayed;s.settings.server='https://b.example';s.settings.token='b-token';s.resume();await cycle;
  expect(s.calls.length).toBeGreaterThan(1);expect(s.calls.every(c=>c.server==='https://a.example'&&c.token==='a-token')).toBe(true);expect(s.b.log).toHaveLength(0);
  await expect(s.connection.run(()=>s.engine.sync())).rejects.toMatchObject({code:'VAULT_MISMATCH'});
  expect(s.calls.at(-1)).toMatchObject({server:'https://b.example',token:'b-token',path:'/v1/info'});expect(s.b.log).toHaveLength(0);
});
test('operation context rejects overlap and clears pin after a failure',async()=>{const s=setup();const delayed=s.delayInfo();const cycle=s.connection.run(async()=>{await new Api(s.connection.http(s.send)).info();throw new Error('failed');});await delayed;await expect(s.connection.run(()=>Promise.resolve())).rejects.toMatchObject({code:'SYNC_BUSY'});s.settings.server='https://b.example';s.settings.token='b-token';s.resume();await expect(cycle).rejects.toThrow('failed');expect(s.connection.current).toEqual(s.settings);});
test('administrator session override takes priority over pinned device credentials',async()=>{const s=setup();await s.connection.run(()=>new Api(s.connection.http(s.send,'admin-token')).info());expect(s.calls[0]).toMatchObject({server:'https://a.example',token:'admin-token'});});
