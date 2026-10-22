import {SyncError} from './types';
import type {ConfigurationSelection} from './configuration-paths';

export interface Settings {
  server: string;
  token: string;
  deviceName: string;
  paused: boolean;
  configuration: ConfigurationSelection;
}
export type ConnectionSettings = Pick<Settings,'server'|'token'|'deviceName'|'paused'>;
export const connectionSettings = (settings:Settings):ConnectionSettings => ({server:settings.server,token:settings.token,deviceName:settings.deviceName,paused:settings.paused});
const same = (left:unknown,right:unknown) => JSON.stringify(left)===JSON.stringify(right);

export class SettingsDraft<T extends object> {
  readonly original:T;
  value:T;
  constructor(value:T){this.original=structuredClone(value);this.value=structuredClone(value);}
  patch():Partial<T> {
    const patch:Partial<T>={};
    for(const key of Object.keys(this.value) as (keyof T)[])if(!same(this.value[key],this.original[key]))patch[key]=structuredClone(this.value[key]);
    return patch;
  }
  expected():Partial<T> {
    const expected:Partial<T>={};
    for(const key of Object.keys(this.patch()) as (keyof T)[])expected[key]=structuredClone(this.original[key]);
    return expected;
  }
  get dirty(){return Object.keys(this.patch()).length>0;}
}

export class SettingsStore<T extends object> {
  private writes=Promise.resolve();
  constructor(private current:()=>T,private persist:(value:T)=>Promise<void>,private apply:(value:T)=>void){}
  update(patch:Partial<T>|((current:T)=>Partial<T>),expected?:Partial<T>) {
    const captured=typeof patch==='function'?patch:structuredClone(patch),baseline=structuredClone(expected);
    const write=this.writes.then(async()=>{
      const current=this.current();
      for(const key of Object.keys(baseline??{}) as (keyof T)[])if(!same(current[key],baseline![key]))throw new SyncError('SETTINGS_CHANGED','Settings changed elsewhere. Reopen settings and try again');
      const changes=typeof captured==='function'?captured(current):captured;
      const next={...current,...structuredClone(changes)};
      await this.persist(next);
      this.apply(next);
    });
    this.writes=write.catch(()=>{});return write;
  }
}
