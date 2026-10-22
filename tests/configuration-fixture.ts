import type {DataAdapter} from 'obsidian';
import {ConfigurationLocal} from '../src/configuration-local';
import {ConfigurationSync} from '../src/configuration-sync';
import {defaultConfigurationSelection} from '../src/configuration-paths';
import {Info, Operation, Result, SyncError} from '../src/types';
import {MemoryRemote, text} from './helpers';

export class ConfigurationRemote extends MemoryRemote {
  uploads=0;failAfter?:number;capability=true;onUpload?:()=>void;
  async info():Promise<Info>{return {...await super.info(),protocol:2,configuration_sync:this.capability,configuration_groups:this.capability,max_file_bytes:20*1024*1024,chunk_algo:'fastcdc',chunk_min:16384,chunk_avg:65536,chunk_max:262144};}
  async missing(hashes:string[]){return {missing:hashes.filter(h=>!this.objects.has(h)),present:hashes.filter(h=>this.objects.has(h)).length};}
  async uploadChunk(hash:string,bytes:Uint8Array){if(this.failAfter!==undefined&&this.uploads>=this.failAfter)throw new Error('network interrupted');this.uploads++;await this.upload(hash,bytes);this.onUpload?.();}
  async downloadChunk(hash:string){return this.download(hash);}
  async apply(op:Operation):Promise<Result>{
    if(op.chunked&&op.chunks!.some(p=>!this.objects.has(p.hash)))throw new SyncError('MISSING_CHUNK','missing');
    const lose=this.loseReply;this.loseReply=false;const result=await super.apply(op);
    result.file.group=op.group;result.file.chunked=!!op.chunked;result.file.chunks=op.chunked?structuredClone(op.chunks):undefined;
    if(lose)throw new Error('response lost');return result;
  }
}
export function configurationDisk(configDir='.obsidian') {
  const files=new Map<string,Uint8Array>(),folders=new Set<string>([configDir]);
  let failRename:((path:string)=>boolean)|undefined,processRace:((path:string)=>void)|undefined;
  const set=(path:string,value:string|Uint8Array)=>{
    const parts=path.split('/');parts.pop();let parent='';for(const p of parts){parent=parent?`${parent}/${p}`:p;folders.add(parent);}
    files.set(path,typeof value==='string'?text(value):value.slice());
  };
  const adapter={
    exists:async(path:string)=>files.has(path)||folders.has(path),
    mkdir:async(path:string)=>{folders.add(path);},
    read:async(path:string)=>{if(!files.has(path))throw new Error('missing');return new TextDecoder().decode(files.get(path)!);},
    readBinary:async(path:string)=>{if(!files.has(path))throw new Error('missing');return files.get(path)!.slice().buffer;},
    write:async(path:string,value:string)=>{set(path,value);},
    writeBinary:async(path:string,value:ArrayBuffer)=>{set(path,new Uint8Array(value));},
    list:async(path:string)=>({files:[...files.keys()].filter(p=>p.startsWith(path+'/')&&!p.slice(path.length+1).includes('/')),folders:[...folders].filter(p=>p.startsWith(path+'/')&&!p.slice(path.length+1).includes('/'))}),
    remove:async(path:string)=>{files.delete(path);},
    rename:async(from:string,to:string)=>{if(failRename?.(to))throw new Error('rename interrupted');if(!files.has(from))throw new Error('missing source');set(to,files.get(from)!);files.delete(from);},
    process:async(path:string,fn:(value:string)=>string)=>{const race=processRace;processRace=undefined;race?.(path);const result=fn(new TextDecoder().decode(files.get(path)!));set(path,result);return result;},
  } as unknown as DataAdapter;
  const local=new ConfigurationLocal(adapter,configDir,`${configDir}/plugins/mindsync/configuration-sync`);
  return {adapter,files,folders,set,local,configDir,failRename:(fn?:((path:string)=>boolean))=>{failRename=fn;},race:(fn:(path:string)=>void)=>{processRace=fn;}};
}
export function configurationPair(){
  const remote=new ConfigurationRemote(),a=configurationDisk(),b=configurationDisk('custom-config');
  const selection=defaultConfigurationSelection();selection.enabled=true;
  const other=structuredClone(selection);
  return {remote,a,b,selection,other,A:new ConfigurationSync(a.local,remote,()=>selection),B:new ConfigurationSync(b.local,remote,()=>other)};
}
export const pluginManifest=(id:string,desktop=false)=>JSON.stringify({id,name:id,version:'1.0.0',minAppVersion:'1.8.0',description:'Test plugin',author:'Test',isDesktopOnly:desktop});
