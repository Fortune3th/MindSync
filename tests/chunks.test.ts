import {Buffer} from 'node:buffer';
import {test,expect} from 'vitest';
import {SyncEngine} from '../src/engine';
import {chunk} from '../src/chunker';
import {Chunk,emptyState,Info,Operation,Result,SyncError} from '../src/types';
import {MemoryLocal,MemoryRemote,sample} from './helpers';

class ChunkRemote extends MemoryRemote {
  uploads: {hash:string;size:number}[]=[]; failAfter?: number; refuseCommit=false; chunkDownloads=0;
  async info(): Promise<Info> {return {...await super.info(),protocol:2,max_file_bytes:20*1024*1024,chunk_algo:'fastcdc',chunk_min:16384,chunk_avg:65536,chunk_max:262144};}
  async missing(hashes:string[]) {return {missing:hashes.filter(h=>!this.objects.has(h)),present:hashes.filter(h=>this.objects.has(h)).length};}
  async uploadChunk(hash:string,bytes:Uint8Array) {
    if(this.failAfter!==undefined && this.uploads.length>=this.failAfter)throw new Error('network interrupted');
    this.uploads.push({hash,size:bytes.length});await super.upload(hash,bytes);
  }
  async downloadChunk(hash:string){this.chunkDownloads++;return this.download(hash);}
  async apply(op:Operation):Promise<Result> {
    if(this.refuseCommit)throw new Error('stopped before commit');
    const existing=this.ops.get(op.operation_id);if(existing)return existing;
    if(op.chunked && op.chunks!.some(p=>!this.objects.has(p.hash)))throw new SyncError('MISSING_CHUNK','missing');
    // Base mock owns conflict/revision rules; retain the manifest in its version records.
    const base=this.files.get(op.file_id);
    const lose=this.loseReply;this.loseReply=false;
    const result=await super.apply(op);
    if(op.kind==='put') {result.file.chunked=!!op.chunked;result.file.chunks=op.chunked?structuredClone(op.chunks):undefined;}
    else {result.file.chunked=base?.chunked;result.file.chunks=base?.chunks;}
    if(lose)throw new Error('response lost');
    return result;
  }
}
function sameBytes(actual: Uint8Array | null, expected: Uint8Array): boolean {
  return actual!==null && Buffer.from(actual.buffer,actual.byteOffset,actual.byteLength)
    .equals(Buffer.from(expected.buffer,expected.byteOffset,expected.byteLength));
}
function setup(){const remote=new ChunkRemote(),local=new MemoryLocal();return {remote,local,engine:new SyncEngine(emptyState(),local,remote)};}
test('identical 2 MiB files deduplicate across identities and download intact',async()=>{
  const {remote,local,engine}=setup(),bytes=sample(2*1024*1024);local.files.set('one.bin',bytes);await engine.sync();
  const uploads=remote.uploads.length;expect(uploads).toBeGreaterThan(1);
  local.files.set('two.bin',bytes);await engine.sync();expect(remote.uploads).toHaveLength(uploads);
  const receiver=new MemoryLocal();await new SyncEngine(emptyState(),receiver,remote).sync();
  expect(sameBytes(await receiver.read('two.bin'),bytes)).toBe(true);expect(remote.chunkDownloads).toBeGreaterThan(1);
});
test('10 MiB candidate resumes after restart without resending present chunks',async()=>{
  const {remote,local,engine}=setup(),bytes=sample(10*1024*1024),parts=await chunk(bytes);
  remote.failAfter=Math.floor(parts.length*0.6);local.files.set('large.bin',bytes);
  await expect(engine.sync()).rejects.toThrow('network interrupted');expect(local.saved.pending[0].chunks).toEqual(parts);
  const before=new Set(remote.uploads.map(p=>p.hash)),sent=remote.uploads.reduce((s,p)=>s+p.size,0);
  const offset=remote.uploads.length;remote.failAfter=undefined;
  await new SyncEngine(structuredClone(local.saved),local,remote).sync();
  const resumed=remote.uploads.slice(offset);expect(resumed.every(p=>!before.has(p.hash))).toBe(true);
  expect(resumed.reduce((s,p)=>s+p.size,0)).toBeLessThan(bytes.length/2);
  expect(sent+resumed.reduce((s,p)=>s+p.size,0)).toBe(bytes.length);
  const receiver=new MemoryLocal();await new SyncEngine(emptyState(),receiver,remote).sync();expect(sameBytes(await receiver.read('large.bin'),bytes)).toBe(true);
});
test('all chunks uploaded before exit: restart commits with zero uploads',async()=>{
  const {remote,local,engine}=setup();local.files.set('file.bin',sample(2*1024*1024));remote.refuseCommit=true;
  await expect(engine.sync()).rejects.toThrow('stopped before commit');const count=remote.uploads.length;
  remote.refuseCommit=false;await new SyncEngine(structuredClone(local.saved),local,remote).sync();expect(remote.uploads).toHaveLength(count);expect(remote.log).toHaveLength(1);
});
test('lost committed reply: restart queries ledger before any missing negotiation',async()=>{
  const {remote,local,engine}=setup();local.files.set('file.bin',sample(2*1024*1024));remote.loseReply=true;
  await expect(engine.sync()).rejects.toThrow('response lost');const count=remote.uploads.length;
  remote.missing=async()=>{throw new Error('must query ledger first');};
  await new SyncEngine(structuredClone(local.saved),local,remote).sync();expect(remote.uploads).toHaveLength(count);expect(remote.log).toHaveLength(1);
});
test('corrupt downloaded chunk never replaces local file',async()=>{
  const {remote,local,engine}=setup();local.files.set('file.bin',sample(2*1024*1024));await engine.sync();remote.corrupt=true;
  const receiver=new MemoryLocal();await expect(new SyncEngine(emptyState(),receiver,remote).sync()).rejects.toMatchObject({code:'HASH_MISMATCH'});expect(await receiver.read('file.bin')).toBeNull();
});
test('small v2 notes remain legacy whole objects; progress includes cached blocks',async()=>{
  const {remote,local,engine}=setup();local.set('note.md','small');const progress:number[]=[];engine.onProgress=p=>{if(p)progress.push(p.completed);};
  await engine.sync();expect(remote.log[0].chunked).toBe(false);expect(progress).toContain(1);
  const other=new MemoryLocal();await new SyncEngine(emptyState(),other,remote).sync();expect(await other.read('note.md')).toEqual(await local.read('note.md'));
});
test('v1 server falls back to whole-object uploads',async()=>{
  const local=new MemoryLocal(),remote=new MemoryRemote();local.files.set('file.bin',sample(700000));await new SyncEngine(emptyState(),local,remote).sync();expect(remote.objects.size).toBe(1);expect(remote.log[0].chunked).toBeUndefined();
});
test('chunked historical content restores using the same file identity',async()=>{
  const {remote,local,engine}=setup(),bytes=sample(2*1024*1024);local.files.set('file.bin',bytes);await engine.sync();const old=structuredClone(remote.log[0]);
  const newer=bytes.slice();newer[500000]^=255;local.files.set('file.bin',newer);await engine.sync();await engine.restore(old.id,old);
  expect(engine.state.files[old.id].revision).toBeGreaterThan(old.revision);expect(sameBytes(await local.read('file.bin'),bytes)).toBe(true);
});
test('invalid manifests and missing negotiations are rejected without dropping candidates',async()=>{
  const {remote,local,engine}=setup();local.files.set('file.bin',sample(2*1024*1024));remote.missing=async()=>({missing:['bad'],present:0});
  await expect(engine.sync()).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(local.saved.pending).toHaveLength(1);
  const receiver=new MemoryLocal();remote.files.set('invalid',{id:'invalid',path:'bad.bin',hash:'0'.repeat(64),revision:1,size:100,deleted:false,chunked:true,chunks:[{hash:'0'.repeat(64),size:101} as Chunk]});
  await expect(new SyncEngine(emptyState(),receiver,remote).sync()).rejects.toMatchObject({code:'INVALID_MANIFEST'});expect(await receiver.read('bad.bin')).toBeNull();
});
test('a failed worker waits for other uploads before releasing operation context',async()=>{
  const {remote,local,engine}=setup();local.files.set('file.bin',sample(2*1024*1024));
  let release!:()=>void,entered!:()=>void,settled=false,calls=0;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  remote.uploadChunk=async(hash,bytes)=>{
    if(calls++===0)throw new Error('worker failure');
    entered();await gate;await remote.upload(hash,bytes);
  };
  const failure=engine.sync().catch(error=>{settled=true;return error;});await started;
  await Promise.resolve();expect(settled).toBe(false);release();expect(await failure).toMatchObject({message:'worker failure'});
  expect(local.saved.pending).toHaveLength(1);
});
