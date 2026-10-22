import type {Http, HttpReply} from './api';
import {SyncError} from './types';
export interface Connection {server: string; token: string}
export type ConnectedHttp = (connection: Connection, method: string, path: string, body?: string | Uint8Array) => Promise<HttpReply>;
// A whole operation must authenticate and mutate the same vault, even if settings change while awaiting I/O.
export class ConnectionContext {
  private active?: Readonly<Connection>;
  constructor(private settings: () => Connection) {}
  get current(): Connection { const value=this.active ?? this.settings(); return {server:value.server,token:value.token}; }
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active) throw new SyncError('SYNC_BUSY','Sync is in progress. Try again later');
    this.active=Object.freeze(this.current);
    try { return await action(); } finally { this.active=undefined; }
  }
  http(send: ConnectedHttp, tokenOverride?: string): Http {
    return (method,path,body) => { const connection=this.current; return send({...connection,token:tokenOverride ?? connection.token},method,path,body); };
  }
}
