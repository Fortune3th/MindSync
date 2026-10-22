import {chunk} from './chunker';
import {ConfigurationLocal, ConfigurationUpdate, parseConfigurationJson} from './configuration-local';
import {allowedConfigurationPath, allowedPlugin, configurationGroup, configurationApplyGroup, ConfigurationSelection, selectedConfigurationPath} from './configuration-paths';
import {Candidate, ConfigurationGroup, decode, digest, encode, FileRecord, Info, Remote, SyncError} from './types';

export interface ConfigurationPublishItem {
  path: string; capturedHash: string | null; content: string; remote?: FileRecord; action: string;
}
export class ConfigurationSync {
  private running=false;
  private stopped=false;
  private maxFileBytes=52428800;
  constructor(readonly local: ConfigurationLocal, private remote: Remote, private selection:()=>ConfigurationSelection, private mobile=false, private compatibleVersion:(version:string)=>boolean=()=>true) {}
  stop(){this.stopped=true;}
  private active() {
    if(this.stopped||!this.selection().enabled)throw new SyncError('CONFIGURATION_DISABLED','Settings and plugin sync is disabled');
  }
  private async run<T>(work:(info:Info)=>Promise<T>):Promise<T> {
    this.active();if(this.running)throw new SyncError('SYNC_BUSY','Configuration sync is in progress');this.running=true;
    try {
      const info=await this.remote.info();this.active();
      if(info.protocol!==2||!info.configuration_sync||!info.configuration_groups)throw new SyncError('CONFIGURATION_UNAVAILABLE','This server does not support settings and plugin sync');
      if(!Number.isSafeInteger(info.max_file_bytes)||info.max_file_bytes<=0)throw new SyncError('INVALID_RESPONSE','Invalid server file size limit');
      this.maxFileBytes=info.max_file_bytes;
      const state=this.local.state;
      if(state.vaultId&&state.vaultId!==info.vault_id)throw new SyncError('VAULT_MISMATCH','Configuration journal belongs to a different library');
      if(state.vaultId&&info.cursor<state.highWatermark)throw new SyncError('SERVER_ROLLBACK','The server was restored to an older revision. Preserve the configuration journal');
      state.vaultId=info.vault_id;state.highWatermark=Math.max(state.highWatermark,info.cursor);await this.local.save();
      return await work(info);
    }finally{this.running=false;}
  }
  private selected(path:string){return selectedConfigurationPath(path,this.selection());}
  private async snapshot(){const snapshot=await this.remote.snapshot();this.active();return snapshot;}
  private async content(file:FileRecord):Promise<Uint8Array> {
    if(!Number.isSafeInteger(file.size)||file.size<0||!allowedConfigurationPath(file.path))throw new SyncError('INVALID_RESPONSE','Invalid remote configuration record');
    if(file.deleted)return new Uint8Array();
    if(file.size>this.maxFileBytes)throw new SyncError('FILE_TOO_LARGE','Remote configuration exceeds the file size limit');
    let bytes:Uint8Array;
    if(file.chunked){
      if(!this.remote.downloadChunk||!file.chunks?.length||file.chunks.length>8192)throw new SyncError('INVALID_MANIFEST','Invalid configuration chunk manifest');
      let total=0;
      for(const part of file.chunks){if(!Number.isSafeInteger(part.size)||part.size<=0||part.size>262144||!/^[a-f0-9]{64}$/.test(part.hash))throw new SyncError('INVALID_MANIFEST','Invalid configuration chunk');total+=part.size;}
      if(total!==file.size)throw new SyncError('INVALID_MANIFEST','Configuration chunk sizes do not match');
      bytes=new Uint8Array(file.size);let offset=0;
      for(const part of file.chunks){this.active();const block=await this.remote.downloadChunk(part.hash);if(block.length!==part.size||await digest(block)!==part.hash)throw new SyncError('HASH_MISMATCH','Configuration chunk failed verification');bytes.set(block,offset);offset+=block.length;}
    }else bytes=await this.remote.download(file.hash);
    if(bytes.length!==file.size||await digest(bytes)!==file.hash)throw new SyncError('HASH_MISMATCH','Configuration content failed verification');
    this.validateContent(file.path,bytes);return bytes;
  }
  private validateContent(path:string,bytes:Uint8Array) {
    if(path.endsWith('.json')){
      try{const value=parseConfigurationJson(bytes);if(['app.json','appearance.json','hotkeys.json'].includes(path)&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error('Expected a settings object');if(path==='community-plugins.json'&&(!Array.isArray(value)||value.some(id=>typeof id!=='string')))throw new Error('Invalid enabled plugin list');}
      catch{throw new SyncError('INVALID_CONFIGURATION',`Invalid JSON configuration: ${path}`);}
    }
  }
  private validateManifest(id:string,bytes:Uint8Array) {
    const value=parseConfigurationJson(bytes) as {id?:string;name?:string;version?:string;minAppVersion?:string;isDesktopOnly?:boolean}|null;
    if(!value||Array.isArray(value)||value.id!==id||typeof value.name!=='string'||!value.name||typeof value.version!=='string'||!value.version||typeof value.minAppVersion!=='string'||!value.minAppVersion)
      throw new SyncError('INVALID_PLUGIN',`Invalid plugin manifest for ${id}`);
    if((this.mobile&&value.isDesktopOnly)||!this.compatibleVersion(value.minAppVersion))throw new SyncError('INCOMPATIBLE_PLUGIN',`Plugin ${id} is not compatible with this device or Obsidian version`);
    return value;
  }
  private publishBytes(path:string,bytes:Uint8Array) {
    this.validateContent(path,bytes);
    if(path!=='community-plugins.json')return bytes;
    const ids=parseConfigurationJson(bytes) as string[],plugins=this.selection().plugins;
    return new TextEncoder().encode(JSON.stringify([...new Set(ids.filter(id=>allowedPlugin(id)&&Object.hasOwn(plugins,id)&&(plugins[id].files||plugins[id].settings)))],null,2)+'\n');
  }
  async inventory() {
    if(this.stopped)throw new SyncError('CONFIGURATION_DISABLED','Configuration sync is stopped');
    if(this.running)throw new SyncError('SYNC_BUSY','Configuration sync is in progress');
    this.running=true;
    try{
      const info=await this.remote.info();
      if(info.protocol!==2||!info.configuration_sync||!info.configuration_groups)throw new SyncError('CONFIGURATION_UNAVAILABLE','This server does not support settings and plugin sync');
      if(this.local.state.vaultId&&this.local.state.vaultId!==info.vault_id)throw new SyncError('VAULT_MISMATCH','Configuration journal belongs to a different library');
      const snapshot=await this.remote.snapshot();
      if(this.stopped)throw new SyncError('CONFIGURATION_DISABLED','Configuration sync is stopped');
      const paths=await this.local.inventory();
      return [...new Set([...paths,...snapshot.files.filter(f=>!f.deleted&&allowedConfigurationPath(f.path)).map(f=>f.path)])].sort();
    }finally{this.running=false;}
  }
  async previewPublish() {
    return this.run(async(info)=>{
      const snapshot=await this.snapshot(),byPath=new Map(snapshot.files.map(f=>[f.path,f])),items:ConfigurationPublishItem[]=[],changedGroups=new Set<string>();
      for(const path of await this.local.inventory()){
        if(!this.selected(path))continue;
        const bytes=await this.local.read(path);if(!bytes)continue;
        if(bytes.length>info.max_file_bytes)throw new SyncError('FILE_TOO_LARGE',`Configuration exceeds the file size limit: ${path}`);
        const content=this.publishBytes(path,bytes),remote=byPath.get(path);
        const unchanged=remote&&!remote.deleted&&await digest(content)===remote.hash;
        if(!unchanged)changedGroups.add(configurationGroup(path));
        items.push({path,capturedHash:await digest(bytes),content:encode(content),remote,action:unchanged?'Include unchanged package file':remote&&!remote.deleted?'Review differing remote content':'Publish'});
      }
      for(const file of snapshot.files){
        if(file.deleted||!this.selected(file.path)||!changedGroups.has(configurationGroup(file.path))||items.some(item=>item.path===file.path))continue;
        items.push({path:file.path,capturedHash:null,content:encode(await this.content(file)),remote:file,action:'Retain existing remote package file'});
      }
      return items.filter(item=>changedGroups.has(configurationGroup(item.path)));
    });
  }
  async publish(items:ConfigurationPublishItem[],force=false) {
    return this.run(async(info)=>{
      await this.flush();const snapshot=await this.snapshot(),byPath=new Map(snapshot.files.map(f=>[f.path,f]));
      const candidates:ConfigurationLocal['state']['pending']=[];
      const groups=new Map<string,ConfigurationGroup>();
      for(const item of items){const key=configurationGroup(item.path);if(!groups.has(key))groups.set(key,{id:crypto.randomUUID(),members:items.filter(i=>configurationGroup(i.path)===key).map(i=>i.path).sort()});}
      const blockedGroups=new Set<string>();
      for(const item of items){
        this.active();
        const current=byPath.get(item.path),base=this.local.state.bases[item.path];
        if(current?.id!==item.remote?.id||current?.revision!==item.remote?.revision)throw new SyncError('REMOTE_CHANGED',`Remote configuration changed: ${item.path}. Preview again`);
        if(!force&&current&&!current.deleted&&base?.file.revision!==current.revision&&await digest(decode(item.content))!==current.hash)blockedGroups.add(configurationGroup(item.path));
      }
      for(const item of items){
        this.active();if(!this.selected(item.path))throw new SyncError('CONFIGURATION_SELECTION_CHANGED','The configuration selection changed. Preview again');
        const bytes=await this.local.read(item.path);
        if((bytes?await digest(bytes):null)!==item.capturedHash)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${item.path}. Preview again`);
        const prepared=bytes?this.publishBytes(item.path,bytes):decode(item.content);
        if(encode(prepared)!==item.content)throw new SyncError('CONFIGURATION_SELECTION_CHANGED','The enabled plugin selection changed. Preview again');
        const current=byPath.get(item.path);
        if(current?.id!==item.remote?.id||current?.revision!==item.remote?.revision)throw new SyncError('REMOTE_CHANGED',`Remote configuration changed: ${item.path}. Preview again`);
        if(blockedGroups.has(configurationGroup(item.path))){if(current)await this.stage(current);continue;}
        if(this.local.state.pending.some(c=>c.op.path===item.path))continue;
        candidates.push(await this.candidate(item.path,prepared,item.capturedHash,current,info,groups.get(configurationGroup(item.path))!));
      }
      this.active();this.local.state.pending.push(...candidates);
      this.local.state.mode='publish';await this.local.save();await this.flush();return candidates.length;
    });
  }
  private async candidate(path:string,bytes:Uint8Array,capturedHash:string|null,current:FileRecord|undefined,info:Info,group:ConfigurationGroup) {
    if(bytes.length>info.max_file_bytes)throw new SyncError('FILE_TOO_LARGE',`Configuration exceeds the file size limit: ${path}`);
    const parts=await chunk(bytes,{min:info.chunk_min!,avg:info.chunk_avg!,max:info.chunk_max!});
    const op={operation_id:crypto.randomUUID(),kind:'put' as const,group,file_id:current?.id??crypto.randomUUID(),path,base_revision:current?.revision??0,hash:await digest(bytes),size:bytes.length,...(parts.length>1?{chunked:true,chunks:parts}:{})};
    return {op,content:encode(bytes),chunks:parts,capturedHash};
  }
  private async upload(candidate:Candidate) {
    if(candidate.content===undefined)throw new SyncError('CONFIGURATION_STATE_CORRUPT','Pending configuration content is missing');
    const bytes=decode(candidate.content);
    if(bytes.length!==candidate.op.size||await digest(bytes)!==candidate.op.hash)throw new SyncError('CONFIGURATION_STATE_CORRUPT','Pending configuration content failed verification');
    if(!candidate.chunks||!this.remote.missing||!this.remote.uploadChunk)throw new SyncError('CONFIGURATION_STATE_CORRUPT','Pending configuration chunk manifest is missing');
    const blocks=new Map<string,Uint8Array>();let offset=0;
    for(const part of candidate.chunks){
      if(!Number.isSafeInteger(part.size)||part.size<0||part.size>262144||offset+part.size>bytes.length)throw new SyncError('CONFIGURATION_STATE_CORRUPT','Invalid pending configuration chunk size');
      const block=bytes.subarray(offset,offset+part.size);if(await digest(block)!==part.hash)throw new SyncError('HASH_MISMATCH','Pending configuration chunk failed verification');blocks.set(part.hash,block);offset+=part.size;
    }
    if(offset!==bytes.length||(candidate.op.chunked&&JSON.stringify(candidate.op.chunks)!==JSON.stringify(candidate.chunks)))throw new SyncError('CONFIGURATION_STATE_CORRUPT','Pending configuration manifest is incomplete');
    const reply=await this.remote.missing([...blocks.keys()]);this.active();
    if(!Array.isArray(reply.missing)||reply.missing.some(h=>!blocks.has(h))||new Set(reply.missing).size!==reply.missing.length||reply.present!==blocks.size-reply.missing.length)throw new SyncError('INVALID_RESPONSE','Invalid missing configuration chunk list');
    let index=0,failure:unknown;
    const worker=async()=>{while(index<reply.missing.length&&failure===undefined){const hash=reply.missing[index++];try{this.active();await this.remote.uploadChunk!(hash,blocks.get(hash)!);}catch(error){failure=error;}}};
    await Promise.all(Array.from({length:Math.min(3,reply.missing.length)},worker));if(failure!==undefined)throw failure;
  }
  private async flush() {
    for(const candidate of [...this.local.state.pending]){
      this.active();if(!this.local.state.pending.some(c=>c.op.operation_id===candidate.op.operation_id))continue;
      // A disabled selection preserves the immutable candidate without sending it.
      if(!candidate.op.path||!this.selected(candidate.op.path))continue;
      try{
        let result=await this.remote.result(candidate.op.operation_id);this.active();
        if(!result){await this.upload(candidate);this.active();result=await this.remote.apply(candidate.op);}
        this.local.state.highWatermark=Math.max(this.local.state.highWatermark,result.cursor);
        this.local.state.bases[result.file.path]={file:result.file,localHash:candidate.capturedHash};
        this.local.state.pending=this.local.state.pending.filter(c=>c.op.operation_id!==candidate.op.operation_id);
        delete this.local.state.updates[result.file.path];await this.local.save();
      }catch(error){
        if(error instanceof SyncError&&['REVISION_CONFLICT','PATH_CONFLICT'].includes(error.code)){
          if(candidate.content!==undefined)await this.local.preserve(candidate.op.path,decode(candidate.content),error.current?.revision??0);
          const group=candidate.op.group?.id;
          for(const sibling of this.local.state.pending.filter(c=>group&&c.op.group?.id===group&&c.op.operation_id!==candidate.op.operation_id))if(sibling.content!==undefined&&sibling.op.path)await this.local.preserve(sibling.op.path,decode(sibling.content),error.current?.revision??0);
          this.local.state.pending=this.local.state.pending.filter(c=>group?c.op.group?.id!==group:c.op.operation_id!==candidate.op.operation_id);await this.local.save();
          if(error.current&&!error.current.deleted&&error.current.path===candidate.op.path)await this.stage(error.current);
        }else throw error;
      }
    }
  }
  private async stage(file:FileRecord) {
    if(!this.selected(file.path))return;
    const current=await this.local.read(file.path),currentHash=current?await digest(current):null,base=this.local.state.bases[file.path];
    if(base&&base.file.id===file.id&&base.file.hash===file.hash&&base.file.deleted===file.deleted){this.local.state.bases[file.path]={file,localHash:base.localHash};delete this.local.state.updates[file.path];return;}
    if((!file.deleted&&currentHash===file.hash)||(file.deleted&&currentHash===null)||(base?.file.revision===file.revision&&currentHash===base.localHash)){
      this.local.state.bases[file.path]={file,localHash:currentHash};delete this.local.state.updates[file.path];return;
    }
    const existing=this.local.state.updates[file.path];
    if(existing?.file.revision===file.revision&&existing.expectedHash===currentHash)return;
    const bytes=file.deleted?null:await this.content(file);this.active();
    const conflict=!!current&&(!base||currentHash!==base.localHash);
    if(conflict&&current)await this.local.preserve(file.path,current,file.revision);
    this.local.state.updates[file.path]={id:crypto.randomUUID(),file,content:bytes?encode(bytes):undefined,expectedHash:currentHash,conflict};
  }
  private completeGroup(file:FileRecord,files:FileRecord[]) {
    if(!file.group)return true;
    const group=file.group;
    if(!group.id||!Array.isArray(group.members)||!group.members.length||group.members.length>4||new Set(group.members).size!==group.members.length||!group.members.includes(file.path))throw new SyncError('INVALID_RESPONSE','Invalid configuration package descriptor');
    return group.members.every(path=>allowedConfigurationPath(path)&&configurationGroup(path)===configurationGroup(file.path)&&files.some(member=>member.path===path&&!member.deleted&&member.group?.id===group.id&&JSON.stringify(member.group.members)===JSON.stringify(group.members)));
  }
  async review() {
    return this.run(async(info)=>{
      await this.flush();const snapshot=await this.snapshot();
      this.local.state.incompleteGroups=[];
      for(const file of snapshot.files){
        if(this.selected(file.path)&&!this.completeGroup(file,snapshot.files)){const group=configurationGroup(file.path);if(!this.local.state.incompleteGroups.includes(group))this.local.state.incompleteGroups.push(group);continue;}
        if(file.size>info.max_file_bytes&&this.selected(file.path))throw new SyncError('FILE_TOO_LARGE',`Remote configuration exceeds the file size limit: ${file.path}`);await this.stage(file);}
      this.local.state.mode??='receive';this.local.state.cursor=snapshot.cursor;await this.local.save();return this.updates();
    });
  }
  updates(){return Object.values(this.local.state.updates).filter(u=>this.selected(u.file.path)).sort((a,b)=>a.file.path.localeCompare(b.file.path));}
  async synchronize() {
    if(!this.local.state.mode)return;
    await this.review();
    const items=await this.previewPublish();
    const changed=items.filter(item=>{
      const base=this.local.state.bases[item.path];
      return (base ? base.localHash!==item.capturedHash : this.local.state.mode==='publish'&&!item.remote)&&!this.local.state.updates[item.path];
    });
    const changedGroups=new Set(changed.map(item=>configurationGroup(item.path)));
    if(changedGroups.size)await this.publish(items.filter(item=>changedGroups.has(configurationGroup(item.path))));
  }
  private async enabledPluginBytes(remoteBytes:Uint8Array,prepared:Map<string,Uint8Array|null>) {
    const incoming=parseConfigurationJson(remoteBytes) as string[],local=await this.local.read('community-plugins.json');
    const current=local?parseConfigurationJson(local):[];
    if(!Array.isArray(current)||current.some(id=>typeof id!=='string'))throw new SyncError('INVALID_CONFIGURATION','The local enabled plugin list is invalid');
    const selected=this.selection().plugins,retained=current.filter(id=>!allowedPlugin(id)||!Object.hasOwn(selected,id)||!(selected[id].files||selected[id].settings));
    for(const id of incoming){
      if(!allowedPlugin(id)||!Object.hasOwn(selected,id)||!(selected[id].files||selected[id].settings))continue;
      const path=`plugins/${id}/manifest.json`,manifest=prepared.has(path)?prepared.get(path):await this.local.read(path);
      const mainPath=`plugins/${id}/main.js`,main=prepared.has(mainPath)?prepared.get(mainPath):await this.local.read(mainPath);
      if(!manifest||!main)continue;
      try{this.validateManifest(id,manifest);retained.push(id);}catch(error){if(!(error instanceof SyncError))throw error;}
    }
    return new TextEncoder().encode(JSON.stringify([...new Set(retained)],null,2)+'\n');
  }
  async apply(updates:ConfigurationUpdate[]) {
    return this.run(async()=>{
      const snapshot=await this.snapshot(),byPath=new Map(snapshot.files.map(f=>[f.path,f]));
      const groups=new Set(updates.map(u=>configurationApplyGroup(u.file.path))),all=this.updates().filter(u=>groups.has(configurationApplyGroup(u.file.path)));
      for(const wanted of updates)if(this.local.state.updates[wanted.file.path]?.id!==wanted.id)throw new SyncError('REMOTE_CHANGED','Configuration preview is stale. Review updates again');
      const prepared=new Map<string,Uint8Array|null>();
      for(const update of all){
        if(!updates.some(wanted=>wanted.id===update.id))throw new SyncError('REMOTE_CHANGED','A configuration group changed. Review every file again');
        if(!this.selected(update.file.path))throw new SyncError('CONFIGURATION_SELECTION_CHANGED','The configuration selection changed. Review again');
        const current=byPath.get(update.file.path);
        if(current&&!this.completeGroup(current,snapshot.files))throw new SyncError('REMOTE_CHANGED','A configuration package upload is incomplete. Wait and review again');
        if(current?.id!==update.file.id||current.revision!==update.file.revision)throw new SyncError('REMOTE_CHANGED','Remote configuration changed. Review updates again');
        if(await this.local.hash(update.file.path)!==update.expectedHash)throw new SyncError('LOCAL_CHANGED',`Configuration changed: ${update.file.path}. Review again`);
        const bytes=update.file.deleted?null:decode(update.content??'');
        if(bytes&&(bytes.length!==update.file.size||await digest(bytes)!==update.file.hash))throw new SyncError('HASH_MISMATCH','Staged configuration failed verification');
        if(bytes)this.validateContent(update.file.path,bytes);prepared.set(update.file.path,bytes);
      }
      for(const group of groups)if(group.startsWith('plugins/')){
        const id=group.split('/')[1],manifestPath=`${group}/manifest.json`,mainPath=`${group}/main.js`;
        const manifest=prepared.has(manifestPath)?prepared.get(manifestPath):await this.local.read(manifestPath);
        const main=prepared.has(mainPath)?prepared.get(mainPath):await this.local.read(mainPath);
        if(manifest===null&&main===null)continue;
        if(!manifest||!main)throw new SyncError('INVALID_PLUGIN',`Plugin ${id} requires both manifest.json and main.js`);
        this.validateManifest(id,manifest);
      }
      if(prepared.get('community-plugins.json'))prepared.set('community-plugins.json',await this.enabledPluginBytes(prepared.get('community-plugins.json')!,prepared));
      const ordered=[...groups].sort((a,b)=>Number(a==='community-plugins.json')-Number(b==='community-plugins.json'));
      let applied=0;
      for(const group of ordered){
        this.active();const members=all.filter(u=>configurationApplyGroup(u.file.path)===group);
        const hashes=new Map<string,string|null>();
        for(const update of members){const bytes=prepared.get(update.file.path);hashes.set(update.file.path,bytes?await digest(bytes):null);}
        await this.local.apply(members.map(u=>({path:u.file.path,bytes:prepared.get(u.file.path)??null,expectedHash:u.expectedHash})),()=>{
          for(const update of members){this.local.state.bases[update.file.path]={file:update.file,localHash:hashes.get(update.file.path)??null};delete this.local.state.updates[update.file.path];}
        });
        applied+=members.length;
      }
      return applied;
    });
  }
  async historyFiles() {
    return this.run(async()=>{
      const snapshot=await this.snapshot();
      return snapshot.files.filter(file=>!file.deleted&&this.selected(file.path)).sort((a,b)=>a.path.localeCompare(b.path));
    });
  }
  async history(fileId:string) {
    return this.run(async()=>{
      if(!this.remote.history)throw new SyncError('UNAVAILABLE','Configuration history is unavailable');
      return this.remote.history(fileId);
    });
  }
  async restore(path:string,version:FileRecord) {
    this.active();
    const bytes=await this.content(version),current=await this.local.read(path),expected=current?await digest(current):null;
    if(current)await this.local.preserve(path,current,version.revision);
    delete this.local.state.updates[path];await this.local.save();
    await this.local.apply([{path,bytes,expectedHash:expected}]);
    const items=(await this.previewPublish()).filter(item=>configurationGroup(item.path)===configurationGroup(path));
    if(items.length)await this.publish(items);
    return version.revision;
  }
  async keepLocal(updates:ConfigurationUpdate[]) {    this.active();
    const snapshot=await this.remote.snapshot(),byPath=new Map(snapshot.files.map(file=>[file.path,file]));
    const groups=new Set(updates.map(update=>configurationGroup(update.file.path)));
    for(const update of updates){
      const current=byPath.get(update.file.path);
      if(this.local.state.updates[update.file.path]?.id!==update.id||current?.id!==update.file.id||current.revision!==update.file.revision)throw new SyncError('REMOTE_CHANGED','Configuration preview is stale. Review again');
      if(await this.local.hash(update.file.path)!==update.expectedHash)throw new SyncError('LOCAL_CHANGED','Local configuration changed. Review again');
    }
    const paths=new Set([...await this.local.inventory(),...snapshot.files.filter(file=>!file.deleted).map(file=>file.path)]),items:ConfigurationPublishItem[]=[];
    for(const path of paths){
      if(!this.selected(path)||!groups.has(configurationGroup(path)))continue;
      const bytes=await this.local.read(path),remote=byPath.get(path);
      const content=bytes?this.publishBytes(path,bytes):remote&&!remote.deleted?await this.content(remote):null;
      if(!content)continue;
      items.push({path,capturedHash:bytes?await digest(bytes):null,content:encode(content),remote,action:bytes?'Keep local':'Retain existing remote package file'});
    }
    return this.publish(items,true);
  }
}
