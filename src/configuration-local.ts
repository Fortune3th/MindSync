import type {DataAdapter} from 'obsidian';
import {Candidate, decode, digest, encode, FileRecord, SyncError} from './types';
import {allowedConfigurationPath} from './configuration-paths';

export interface ConfigurationUpdate {
  id: string; file: FileRecord; content?: string; expectedHash: string | null; conflict: boolean;
}
export interface ConfigurationConflict {id: string; path: string; content: string; hash: string; revision: number}
export interface ConfigurationIntent {id: string; items: {path: string; before: string | null; after: string | null}[]}
export interface ConfigurationState {
  version: 1; vaultId?: string; highWatermark: number; cursor: number;
  mode?: 'publish' | 'receive';
  bases: Record<string, {file: FileRecord; localHash: string | null}>;
  pending: (Candidate & {capturedHash: string | null})[];
  updates: Record<string, ConfigurationUpdate>;
  conflicts: ConfigurationConflict[];
  intent?: ConfigurationIntent;
  recoveryNotice?: string;
  incompleteGroups?: string[];
}
export const emptyConfigurationState = (): ConfigurationState => ({version:1,highWatermark:0,cursor:0,bases:{},pending:[],updates:{},conflicts:[]});
const utf8 = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
export function parseConfigurationJson(bytes: Uint8Array): unknown {
  return JSON.parse(utf8.decode(bytes).replace(/^\uFEFF/,''));
}

export class ConfigurationLocal {
  state=emptyConfigurationState();
  private sequence=0;
  private writes=Promise.resolve();
  constructor(readonly adapter: DataAdapter, readonly configDir: string, readonly directory: string) {}
  private physical(path: string) {
    if (!allowedConfigurationPath(path)) throw new SyncError('INVALID_CONFIGURATION_PATH','This configuration path is excluded');
    return `${this.configDir}/${path}`;
  }
  async parents(path: string) {
    const parts=path.split('/');parts.pop();let parent='';
    for (const part of parts) {
      parent=parent?`${parent}/${part}`:part;
      if (!(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
    }
  }
  async load() {
    const valid: {sequence:number;state:ConfigurationState}[]=[];let exists=false;
    for(let slot=0;slot<2;slot++) {
      const path=`${this.directory}/state-${slot}.json`;
      if (!(await this.adapter.exists(path))) continue;
      exists=true;
      try {
        const item=JSON.parse(await this.adapter.read(path));
        if (Number.isSafeInteger(item.sequence) && item.sequence>0 && item.state?.version===1
          && Number.isSafeInteger(item.state.cursor) && item.state.cursor>=0
          && Number.isSafeInteger(item.state.highWatermark) && item.state.highWatermark>=0
          && item.state.bases && item.state.updates && Array.isArray(item.state.pending) && Array.isArray(item.state.conflicts)
          && await digest(new TextEncoder().encode(JSON.stringify(item.state)))===item.checksum) valid.push(item);
      } catch { /* The other checksum-protected slot survives an interrupted write. */ }
    }
    if(exists&&!valid.length)throw new SyncError('CONFIGURATION_STATE_CORRUPT','Configuration sync journal is corrupted. Preserve its backup before reconnecting');
    const latest=valid.sort((a,b)=>b.sequence-a.sequence)[0];this.sequence=latest?.sequence??0;this.state=latest?.state??emptyConfigurationState();
    if(this.state.intent)await this.rollback(this.state.intent);
    return this.state;
  }
  async save() {
    const state=structuredClone(this.state);
    const work=this.writes.then(async()=>{
      const sequence=this.sequence+1;
      await this.parents(`${this.directory}/state-0.json`);
      await this.adapter.write(`${this.directory}/state-${sequence%2}.json`,JSON.stringify({sequence,state,checksum:await digest(new TextEncoder().encode(JSON.stringify(state)))}));
      this.sequence=sequence;
    });
    this.writes=work.catch(()=>{});await work;
  }
  async read(path: string): Promise<Uint8Array|null> {
    const physical=this.physical(path);
    return await this.adapter.exists(physical)?new Uint8Array(await this.adapter.readBinary(physical)):null;
  }
  async hash(path: string) {const bytes=await this.read(path);return bytes?digest(bytes):null;}
  async inventory() {
    const paths: string[]=[];
    const walk=async(directory:string,depth:number)=>{
      if(!(await this.adapter.exists(directory)))return;
      const listing=await this.adapter.list(directory);
      for(const path of listing.files){const relative=path.slice(this.configDir.length+1);if(allowedConfigurationPath(relative))paths.push(relative);}
      if(depth>0)for(const folder of listing.folders){
        const relative=folder.slice(this.configDir.length+1);
        if(!relative.split('/').some(p=>p.startsWith('.')||['mindsync','obsidian-livesync','node_modules'].includes(p)))await walk(folder,depth-1);
      }
    };
    await walk(this.configDir,0);
    for(const folder of ['plugins','themes','snippets'])await walk(`${this.configDir}/${folder}`,1);
    return [...new Set(paths)].sort();
  }
  async preserve(path: string, bytes: Uint8Array, revision: number) {
    const hash=await digest(bytes);
    const existing=this.state.conflicts.find(c=>c.path===path&&c.hash===hash&&c.revision===revision);
    if(existing)return existing;
    const conflict={id:crypto.randomUUID(),path,content:encode(bytes),hash,revision};
    await this.parents(`${this.directory}/conflicts/${conflict.id}.bin`);
    await this.adapter.writeBinary(`${this.directory}/conflicts/${conflict.id}.bin`,bytes.slice().buffer);
    this.state.conflicts.push(conflict);await this.save();return conflict;
  }
  private async write(path: string, bytes: Uint8Array|null, expected: string|null) {
    const physical=this.physical(path),current=await this.read(path);
    if((current?await digest(current):null)!==expected)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${path}. Review again`);
    if(bytes===null){if(current)await this.adapter.remove(physical);return;}
    await this.parents(physical);
    if(current&&path.endsWith('.json')){
      const before=utf8.decode(current),after=utf8.decode(bytes);let changed=false;
      await this.adapter.process(physical,text=>{if(text!==before)return text;changed=true;return after;});
      if(!changed)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${path}. Review again`);
    }else{
      const temporary=`${this.directory}/temporary/${crypto.randomUUID()}.bin`;
      await this.parents(temporary);await this.adapter.writeBinary(temporary,bytes.slice().buffer);
      try{
        if(await this.hash(path)!==expected)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${path}. Review again`);
        await this.adapter.rename(temporary,physical);
      }finally{if(await this.adapter.exists(temporary))await this.adapter.remove(temporary);}
    }
  }
  async apply(items: {path:string;bytes:Uint8Array|null;expectedHash:string|null}[],commit?:()=>void) {
    if(this.state.intent)throw new SyncError('CONFIGURATION_RECOVERY','An unfinished configuration update must recover first');
    const intent:ConfigurationIntent={id:crypto.randomUUID(),items:[]};
    for(const item of items){
      const before=await this.read(item.path);
      if((before?await digest(before):null)!==item.expectedHash)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${item.path}. Review again`);
      intent.items.push({path:item.path,before:before?encode(before):null,after:item.bytes?encode(item.bytes):null});
    }
    await this.parents(`${this.directory}/backups/${intent.id}.json`);
    await this.adapter.write(`${this.directory}/backups/${intent.id}.json`,JSON.stringify(intent));
    this.state.intent=intent;await this.save();
    const prior={bases:{...this.state.bases},updates:{...this.state.updates}};
    try{
      for(const item of items)await this.write(item.path,item.bytes,item.expectedHash);
      commit?.();this.state.intent=undefined;await this.save();
    }catch(error){this.state.bases=prior.bases;this.state.updates=prior.updates;await this.rollback(intent);throw error;}
  }
  private async rollback(intent: ConfigurationIntent) {
    this.state.intent=intent;
    for(const item of [...intent.items].reverse()){
      const current=await this.hash(item.path),before=item.before===null?null:decode(item.before),after=item.after===null?null:decode(item.after);
      const original=before?await digest(before):null,intended=after?await digest(after):null;
      if(current===original)continue;
      if(current!==intended){
        const bytes=await this.read(item.path);if(bytes)await this.preserve(item.path,bytes,0);
        this.state.recoveryNotice='Recovered an interrupted update. Concurrent edits were preserved; review the configuration again';
        continue;
      }
      await this.write(item.path,before,current);
    }
    this.state.intent=undefined;await this.save();
  }
}
