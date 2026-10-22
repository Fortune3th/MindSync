export interface ConfigurationGroup {id: string; members: string[]}
export interface Chunk { hash: string; size: number }
export interface FileRecord { id: string; path: string; revision: number; hash: string; size: number; deleted: boolean; chunked?: boolean; chunks?: Chunk[]; group?: ConfigurationGroup }
export interface Operation { operation_id: string; kind: 'put' | 'rename' | 'delete'; file_id: string; path?: string; base_revision: number; hash?: string; size?: number; chunked?: boolean; chunks?: Chunk[]; group?: ConfigurationGroup }
export interface Result { file: FileRecord; cursor: number }
export interface Info { protocol: number; vault_id: string; max_file_bytes: number; cursor: number; storage_bytes: number; logical_bytes?: number; chunk_algo?: string; chunk_min?: number; chunk_avg?: number; chunk_max?: number; configuration_sync?: boolean; configuration_groups?: boolean }
export interface Snapshot { files: FileRecord[]; cursor: number }
export interface Changes { changes: FileRecord[]; cursor: number; until: number; has_more: boolean }
export interface Remote {
  info(): Promise<Info>; snapshot(): Promise<Snapshot>;
  changes(after: number, until?: number): Promise<Changes>;
  upload(hash: string, bytes: Uint8Array): Promise<void>;
  download(hash: string): Promise<Uint8Array>;
  missing?(hashes: string[]): Promise<{missing:string[];present:number}>;
  uploadChunk?(hash: string, bytes: Uint8Array): Promise<void>;
  downloadChunk?(hash: string): Promise<Uint8Array>;
  apply(op: Operation): Promise<Result>;
  result(id: string): Promise<Result | null>;
  history?(id: string): Promise<{versions: FileRecord[]}>;
}
export interface Local {
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array | null>;
  // Conditional writes must preserve any intervening content as a new file.
  replace(path: string, bytes: Uint8Array | null, expectedHash: string | null): Promise<boolean>;
  create(path: string, bytes: Uint8Array): Promise<void>;
  save(state: SyncState): Promise<void>;
}
export interface Candidate { op: Operation; content?: string; chunks?: Chunk[]; restore?: boolean }
export interface SyncState {
  version: 1; vaultId?: string; remoteHighWatermark?: number; initialMergeApproved?: boolean; initialized: boolean; cursor: number;
  files: Record<string, FileRecord>; pending: Candidate[];
  renameGroups?: Record<string, {temporary: string; targets: Record<string,string>}>;
  conflictDetails?: Record<string, {source: string; device: string; time: string}>;
  rescanRemote?: boolean; renames: Record<string, string>; conflicts: string[]; lastSuccess?: string;
}
export const emptyState = (): SyncState => ({version: 1, initialized: false, cursor: 0, files: {}, pending: [], renames: {}, conflicts: []});
export class SyncError extends Error {
  constructor(public code: string, message: string, public current?: FileRecord | null) { super(message); }
}
export const digest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))).map(x => x.toString(16).padStart(2, '0')).join('');
export function encode(bytes: Uint8Array): string {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export const decode = (text: string): Uint8Array => Uint8Array.from(atob(text), x => x.charCodeAt(0));
export function validatePath(path: string): string {
  const parts = path.split('/');
  if (path !== path.normalize('NFC') || path.length > 1024 || parts.some(p => new TextEncoder().encode(p).length > 255 || !p || p === '.' || p === '..' || /[\\\x00-\x1f<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(p)))
    throw new SyncError('INVALID_PATH', `This file path cannot be synced across platforms: ${path}`);
  return path;
}
export function included(path: string, configDir = '.obsidian'): boolean {
  return !path.split('/').some(p => p.startsWith('.') || p === configDir || p === 'node_modules') && !/(^|\/)(Thumbs\.db|desktop\.ini)$|(~|\.tmp)$/i.test(path);
}

// Conservative Unicode caseless comparison also detects expanding letters such as ß.
export const pathKey = (path: string): string => path.normalize('NFC').toUpperCase().toLowerCase();
