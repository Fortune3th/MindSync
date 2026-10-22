// Collection verification for dedicated fixture data only, never the notes library.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {utimes,realpath,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Api} from '../../src/api';
import {digest} from '../../src/types';
const base=process.env.MINDSYNC_TEST_URL??'http://127.0.0.1:18085',token=process.env.MINDSYNC_ADMIN_SESSION;
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));assert(token);
const root=process.env.MINDSYNC_TEST_DATA;assert(root,'Fixture data root required');
const remoteHost=process.env.MINDSYNC_TEST_SSH;
if(remoteHost)assert(remoteHost==='feiniu' && root==='/vol1/1000/library/.mindsync-v2-verification','Only the dedicated NAS fixture is allowed');
else {
 const resolved=await realpath(root);
 assert(resolved.startsWith(join(process.cwd(),'nas-data')+'/') || resolved==='/vol1/1000/library/.mindsync-v2-verification','Only dedicated fixture directories are allowed');
}
const request=async(method:string,path:string,body?:string|Uint8Array)=>{const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body.slice().buffer:body});return {status:response.status,body:await response.arrayBuffer()};};
const api=new Api(request);
const orphan=new TextEncoder().encode(`unreferenced test object ${crypto.randomUUID()}`),pending=new TextEncoder().encode(`resumable test object ${crypto.randomUUID()}`);
const orphanHash=await digest(orphan),pendingHash=await digest(pending);await api.uploadChunk(orphanHash,orphan);await api.uploadChunk(pendingHash,pending);
const old=new Date(Date.now()-8*86400000);
if(remoteHost){execFileSync('ssh',['-o','BatchMode=yes',remoteHost,'python3','-'],{input:`import os,json\nroot=${JSON.stringify(root)}\nfor name in os.listdir(root+'/objects'):\n assert len(name)==64 and all(c in '0123456789abcdef' for c in name)\n path=root+'/objects/'+name\n os.utime(path,(${old.getTime()/1000},${old.getTime()/1000}),follow_symlinks=False)\n`});}
else for(const hash of await readdir(join(root,'objects'))){assert(/^[a-f0-9]{64}$/.test(hash));await utimes(join(root,'objects',hash),old,old);}
assert.deepEqual((await api.missing([pendingHash])).missing,[]);
const before=await api.info();
const gc=async(dry_run:boolean)=>{const reply=await request('POST','/v1/maintenance/gc',JSON.stringify({dry_run}));assert.equal(reply.status,200);return JSON.parse(new TextDecoder().decode(reply.body));};
const preview=await gc(true);assert.equal(preview.objects,1);assert.equal(preview.bytes,orphan.length);
const collected=await gc(false);assert.equal(collected.objects,1);
const after=await api.info();assert.equal(after.logical_bytes,before.logical_bytes);assert.equal(before.storage_bytes-after.storage_bytes,orphan.length);
assert.deepEqual(await api.downloadChunk(pendingHash),pending);
const missing=await api.missing([orphanHash]);assert.deepEqual(missing.missing,[orphanHash]);
let versions=0;
for(const file of (await api.snapshot()).files){for(const version of (await api.history(file.id)).versions.filter(v=>!v.deleted)){
 const parts=version.chunked?version.chunks!:[{hash:version.hash,size:version.size}];
 const bytes=new Uint8Array(version.size);let offset=0;
 for(const part of parts){const body=version.chunked?await api.downloadChunk(part.hash):await api.download(part.hash);assert.equal(await digest(body),part.hash);bytes.set(body,offset);offset+=body.length;}
 assert.equal(offset,version.size);assert.equal(await digest(bytes),version.hash);versions++;
}}
await api.apply({operation_id:crypto.randomUUID(),kind:'put',file_id:crypto.randomUUID(),path:`gc-pending-${crypto.randomUUID()}.bin`,base_revision:0,hash:pendingHash,size:pending.length});
console.log(JSON.stringify({dry_run_objects:preview.objects,collected_objects:collected.objects,storage_reclaimed:orphan.length,logical_bytes_unchanged:true,readable_historical_versions:versions,pending_object_preserved:true},null,2));
