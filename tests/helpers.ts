import {Candidate, Changes, digest, emptyState, FileRecord, Info, Local, Operation, Remote, Result, Snapshot, SyncError, SyncState} from '../src/types';
export const text = (s: string) => new TextEncoder().encode(s);
export const string = (b: Uint8Array | null) => b ? new TextDecoder().decode(b) : null;
export class MemoryLocal implements Local {
  files = new Map<string, Uint8Array>(); saved = emptyState(); failSave = false; race?: () => void;
  async list() { return [...this.files.keys()]; }
  async read(path: string) { return this.files.get(path)?.slice() ?? null; }
  async create(path: string, bytes: Uint8Array) { if (this.files.has(path)) throw new Error('exists'); this.files.set(path, bytes.slice()); }
  async replace(path: string, bytes: Uint8Array | null, expected: string | null) {
    this.race?.(); this.race = undefined;
    const current = await this.read(path); if ((current ? await digest(current) : null) !== expected) return false;
    if (bytes) this.files.set(path, bytes.slice()); else this.files.delete(path); return true;
  }
  async save(state: SyncState) { if (this.failSave) throw new Error('disk full'); this.saved = structuredClone(state); }
  set(path: string, content: string) { this.files.set(path, text(content)); }
}
export class MemoryRemote implements Remote {
  files = new Map<string, FileRecord>(); objects = new Map<string, Uint8Array>(); log: FileRecord[] = []; ops = new Map<string, Result>(); candidates: Candidate[] = [];
  loseReply = false; unavailable = false; corrupt = false;
  async info(): Promise<Info> { if (this.unavailable) throw new Error('offline'); return {protocol:1,vault_id:'test-vault',max_file_bytes:1024*1024,cursor:this.log.length,storage_bytes:0}; }
  async snapshot(): Promise<Snapshot> { return {files:[...this.files.values()].map(f => ({...f})),cursor:this.log.length}; }
  async changes(after: number, until = this.log.length): Promise<Changes> {
    const changes = this.log.filter(f => f.revision > after && f.revision <= until).slice(0, 2);
    const cursor = changes.at(-1)?.revision ?? until;
    return {changes,cursor,until,has_more:cursor < until};
  }
  async upload(hash: string, bytes: Uint8Array) { if (this.unavailable) throw new Error('offline'); this.objects.set(hash,bytes.slice()); }
  async download(hash: string) { if (this.corrupt) return text('corrupt'); const b = this.objects.get(hash); if (!b) throw new Error('missing'); return b.slice(); }
  async result(id: string) { return this.ops.get(id) ?? null; }
  async apply(op: Operation): Promise<Result> {
    if (this.unavailable) throw new Error('offline');
    const replay = this.ops.get(op.operation_id); if (replay) return replay;
    const base = this.files.get(op.file_id);
    if ((base?.revision ?? 0) !== op.base_revision) throw new SyncError('REVISION_CONFLICT','stale',base);
    const path = op.path ?? base?.path ?? '';
    const collision = [...this.files.values()].find(f => !f.deleted && f.id !== op.file_id && f.path.toLowerCase() === path.toLowerCase());
    if (collision) throw new SyncError('PATH_CONFLICT','occupied',collision);
    const file: FileRecord = {id:op.file_id,path,revision:this.log.length+1,hash:op.hash ?? base?.hash ?? '',size:op.size ?? base?.size ?? 0,deleted:op.kind === 'delete'};
    this.files.set(file.id,file);this.log.push(file);const result={file,cursor:file.revision};this.ops.set(op.operation_id,result);
    if(this.loseReply){this.loseReply=false;throw new Error('response lost');}return result;
  }
}

export function sample(length: number): Uint8Array {
  const bytes=new Uint8Array(length); let seed=0x13579bdf;
  for(let i=0;i<length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;bytes[i]=seed>>>24;}
  return bytes;
}
