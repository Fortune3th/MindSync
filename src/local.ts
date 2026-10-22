import {App, TFile, TFolder} from 'obsidian';
import {decode, digest, emptyState, encode, included, Local, pathKey, SyncError, SyncState} from './types';
interface FolderMove {original: string; target: string}
interface Envelope { sequence: number; state: SyncState; checksum: string; recoveries?: Record<string, string>; folderMoves?: Record<string, FolderMove> }
export class ObsidianLocal implements Local {
  private sequence = 0;
  private saves = Promise.resolve();
  private recoveries: Record<string, string> = {};
  private latestState = emptyState();
  private folderMoves: Record<string,FolderMove> = {};
  private folderRecovery?: Promise<void>;
  writing = false;
  constructor(private app: App, private directory: string) {}
  async load(): Promise<SyncState> {
    const valid: Envelope[] = []; let exists = false;
    for (let i=0;i<2;i++) {
      const path = `${this.directory}/state-${i}.json`;
      if (!(await this.app.vault.adapter.exists(path))) continue;
      exists = true;
      try {
        const item = JSON.parse(await this.app.vault.adapter.read(path)) as Envelope;
        const state = item.state;
        const recoveryValid = item.recoveries === undefined || (item.recoveries !== null && typeof item.recoveries === 'object' && Object.values(item.recoveries).every(v => typeof v === 'string'));
        const data = item.folderMoves !== undefined ? {state, recoveries:item.recoveries, folderMoves:item.folderMoves} : item.recoveries === undefined ? state : {state, recoveries:item.recoveries};
        if (Number.isSafeInteger(item.sequence) && item.sequence > 0 && state.version === 1 && state.files && state.renames && Array.isArray(state.conflicts) && Array.isArray(state.pending) && Number.isSafeInteger(state.cursor) && recoveryValid && item.checksum === await digest(new TextEncoder().encode(JSON.stringify(data)))) valid.push(item);
      } catch { /* the other slot survives an interrupted write */ }
    }
    if (exists && !valid.length) throw new SyncError('STATE_CORRUPT','The local sync journal is corrupted. Restore a plugin-directory backup or connect from a new vault');
    const latest = valid.sort((a,b)=>b.sequence-a.sequence)[0]; this.sequence = latest?.sequence ?? 0;
    this.recoveries = latest?.recoveries ?? {};
    this.latestState = latest?.state ?? emptyState();
    this.folderMoves = latest?.folderMoves ?? {};
    await this.recoverFolders();
    return this.latestState;
  }
  async list() { await this.recoverFolders(); return [...new Set([...this.app.vault.getFiles().map(f=>f.path), ...Object.keys(this.recoveries)])].filter(p=>included(p,this.app.vault.configDir)); }
  async read(path: string) {
    await this.recoverFolders();
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : this.recoveries[path] !== undefined ? decode(this.recoveries[path]) : null;
  }
  private recoverFolders(): Promise<void> {
    if (!this.folderRecovery) this.folderRecovery=this.recoverFoldersNow().finally(()=>{this.folderRecovery=undefined;});
    return this.folderRecovery;
  }
  private moveRecoveryPaths(original: string, target: string) {
    for (const [path,bytes] of Object.entries(this.recoveries)) if (path.startsWith(original+'/')) {
      const next=target+path.slice(original.length);
      if (next===path) continue;
      if (this.recoveries[next] !== undefined && this.recoveries[next] !== bytes) throw new SyncError('LOCAL_RECOVERY','Attachment recovery paths conflict. Preserve the plugin journal and local vault');
      this.recoveries[next]=bytes; delete this.recoveries[path];
    }
  }
  private async recoverFoldersNow() {
    if (!Object.keys(this.folderMoves).length) return;
    const writing=this.writing; this.writing=true;
    try {
    for (const [temporary,move] of Object.entries(this.folderMoves)) {
      const staging=this.app.vault.getAbstractFileByPath(temporary);
      const original=this.app.vault.getAbstractFileByPath(move.original);
      if (staging) await this.app.vault.rename(staging,move.target);
      else if (!this.app.vault.getAbstractFileByPath(move.target) && original) {
        await this.app.vault.rename(original,temporary); await this.app.vault.rename(original,move.target);
      } else if (!this.app.vault.getAbstractFileByPath(move.target)) throw new SyncError('LOCAL_RECOVERY','Folder rename recovery failed. Preserve the plugin journal and local vault');
      this.moveRecoveryPaths(move.original,move.target);
      delete this.folderMoves[temporary]; await this.save(this.latestState);
    }
    } finally { this.writing=writing; }
  }
  private async parents(path: string) {
    const parts = path.split('/'); parts.pop(); let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(parent)) continue;
      const equivalent = this.app.vault.getAllLoadedFiles().find(f => f instanceof TFolder && pathKey(f.path) === pathKey(parent));
      if (equivalent) {
        // Two moves are required on case insensitive file systems, including for directories.
        const slash = parent.lastIndexOf('/');
        const temporary = `${slash < 0 ? '' : parent.slice(0,slash+1)}MindSync Local Rename ${crypto.randomUUID()}`;
        const original = equivalent.path;
        this.folderMoves[temporary]={original,target:parent}; await this.save(this.latestState);
        await this.app.vault.rename(equivalent, temporary);
        try { await this.app.vault.rename(equivalent, parent); }
        catch (error) {
          try { await this.app.vault.rename(equivalent, original); delete this.folderMoves[temporary]; await this.save(this.latestState); } catch { /* recover before the next scan or after restart */ }
          throw error;
        }
        this.moveRecoveryPaths(original,parent);
        delete this.folderMoves[temporary]; await this.save(this.latestState);
      } else await this.app.vault.createFolder(parent);
    }
  }
  private async clearRecovery(path: string) {
    if (this.recoveries[path] !== undefined) { delete this.recoveries[path]; await this.save(this.latestState); }
  }
  async create(path: string, bytes: Uint8Array) {
    this.writing = true;
    try { await this.parents(path); await this.app.vault.createBinary(path,bytes.slice().buffer); await this.clearRecovery(path); }
    finally { this.writing = false; }
  }
  async replace(path: string, bytes: Uint8Array | null, expected: string | null) {
    await this.recoverFolders();
    const file = this.app.vault.getAbstractFileByPath(path);
    const current = await this.read(path);
    if ((current ? await digest(current) : null) !== expected) return false;
    if (!(file instanceof TFile)) { if (bytes) await this.create(path, bytes); else await this.clearRecovery(path); return true; }
    this.writing = true;
    try {
      if (!bytes) {
        // Use Obsidian's local trash, retaining the actual file even if an
        // external editor writes in the short interval before the move.
        await this.app.vault.trash(file, false); await this.clearRecovery(path);
      } else if (file.extension === 'md') {
        const before = new TextDecoder().decode(current!); let changed = false;
        const after = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        await this.app.vault.process(file, data=>{ if (data !== before) return data; changed=true; return after; });
        return changed;
      } else {
        // Binary attachments lack a Vault CAS API. Preserve the last observed
        // bytes in the local trash before replacement, then create the new file.
        // Persist the old bytes before moving the file. If creation fails (or the
        // process stops), reads/scans retain this virtual file until replacement
        // succeeds, so a missing attachment can never become a queued deletion.
        this.recoveries[path] = encode(current!); await this.save(this.latestState);
        await this.app.vault.trash(file, false); await this.parents(path);
        try {
          await this.app.vault.createBinary(path,bytes.slice().buffer);
        } catch (error) {
          try { if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createBinary(path,current!.slice().buffer); } catch { /* durable recovery remains visible to the engine */ }
          throw error;
        }
        await this.clearRecovery(path);
      }
      return true;
    } finally { this.writing = false; }
  }
  async save(state: SyncState) {
    const copy = structuredClone(state); this.latestState = copy;
    const recoveries = structuredClone(this.recoveries);
    const folderMoves = structuredClone(this.folderMoves);
    const task = this.saves.then(async()=>{
      const sequence = this.sequence + 1;
      const envelope: Envelope = {sequence,state:copy,recoveries,folderMoves,checksum:await digest(new TextEncoder().encode(JSON.stringify({state:copy,recoveries,folderMoves})))};
      await this.app.vault.adapter.write(`${this.directory}/state-${sequence % 2}.json`,JSON.stringify(envelope));
      this.sequence = sequence;
    });
    this.saves = task.catch(()=>{}); await task;
  }
}
