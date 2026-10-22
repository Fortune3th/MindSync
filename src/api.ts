import {Changes, Info, Operation, Remote, Result, Snapshot, SyncError} from './types';
export interface HttpReply { status: number; body: ArrayBuffer }
export type Http = (method: string, path: string, body?: string | Uint8Array) => Promise<HttpReply>;
export class Api implements Remote {
  constructor(private http: Http, private scope: 'notes' | 'configuration' = 'notes') {}
  private async request<T>(method: string, path: string, body?: unknown, binary = false): Promise<T> {
    const scoped = this.scope === 'configuration' && /^\/v1\/(snapshot|changes|operations|files)([/?]|$)/.test(path)
      ? path.replace('/v1/', '/v1/configuration/') : path;
    const reply = await this.http(method, scoped, body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body));
    if (reply.status < 400 && binary) return new Uint8Array(reply.body) as T;
    const text = new TextDecoder().decode(reply.body);
    if (reply.status >= 400) {
      let error: {code?:string;message?:string;current?:Result['file']|null} = {};
      try { error = JSON.parse(text).error ?? {}; } catch { /* reverse proxies may return HTML */ }
      throw new SyncError(error.code ?? `HTTP_${reply.status}`, error.message ?? `Server returned ${reply.status}. Check the connection and settings`, error.current);
    }
    try { return JSON.parse(text) as T; } catch { throw new SyncError('INVALID_RESPONSE',`The server returned invalid data for ${method} ${path} (HTTP ${reply.status})`); }
  }
  info() { return this.request<Info>('GET','/v1/info'); }
  snapshot() { return this.request<Snapshot>('GET','/v1/snapshot'); }
  changes(after: number, until?: number) { return this.request<Changes>('GET',`/v1/changes?after=${after}&limit=100${until === undefined ? '' : `&until=${until}`}`); }
  async upload(hash: string, bytes: Uint8Array) { await this.request('PUT',`/v1/objects/${hash}`,bytes); }
  download(hash: string) { return this.request<Uint8Array>('GET',`/v1/objects/${hash}`,undefined,true); }
  missing(hashes: string[]) { return this.request<{missing:string[];present:number}>('POST','/v1/chunks/missing',{hashes}); }
  private async retryChunk<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt=0;;attempt++) {
      try { return await work(); }
      catch (error) {
        const retryable=!(error instanceof SyncError) || ['TIMEOUT','HTTP_408','HTTP_429','HTTP_500','HTTP_502','HTTP_503','HTTP_504','STORAGE_ERROR'].includes(error.code);
        if (!retryable || attempt>=2) throw error;
        await new Promise(resolve=>setTimeout(resolve,250*2**attempt));
      }
    }
  }
  async uploadChunk(hash: string, bytes: Uint8Array) { await this.retryChunk(()=>this.request('PUT',`/v1/chunks/${hash}`,bytes)); }
  downloadChunk(hash: string) { return this.retryChunk(()=>this.request<Uint8Array>('GET',`/v1/chunks/${hash}`,undefined,true)); }
  apply(op: Operation) { return this.request<Result>('POST','/v1/operations',op); }
  async result(id: string) { try { return await this.request<Result>('GET',`/v1/operations/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof SyncError && (e.code === 'NOT_FOUND' || e.code === 'HTTP_404')) return null; throw e; } }
  login(email: string, password: string) { return this.request<{session_token:string}>('POST','/v1/auth/login',{email,password,cli:true}); }
  logout() { return this.request('POST','/v1/auth/logout'); }
  register(name: string) { return this.request<{id:string;name:string;token:string}>('POST','/v1/devices',{name}); }
  devices() { return this.request<{devices:{id:string;name:string}[]}>('GET','/v1/devices'); }
  revoke(id: string) { return this.request('DELETE',`/v1/devices/${encodeURIComponent(id)}`); }
  history(id: string) { return this.request<{versions:Result['file'][]}>('GET',`/v1/files/${encodeURIComponent(id)}/history`); }
}
