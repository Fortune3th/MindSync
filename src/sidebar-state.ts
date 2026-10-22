import type {TransferProgress} from './engine';

export type SidebarAction='sync'|'preview'|'history'|'pause'|'configuration'|'review';

export interface SidebarSnapshot {
  available:boolean;
  connected:boolean;
  ready:boolean;
  configurationReady:boolean;
  configurationEnabled:boolean;
  paused:boolean;
  busy:boolean;
  activityVisible:boolean;
  activity:string;
  status:string;
  error:string;
  progress?:TransferProgress;
  lastSuccess?:string;
  pending:number;
  configurationStatus:string;
  updates:number;
  conflicts:{path:string;source?:string;device?:string;time?:string}[];
  feedback?:{text:string;error:boolean};
}

export function sidebarPresentation(state:SidebarSnapshot) {
  const busy=state.busy&&state.activityVisible;
  const network=state.available&&state.connected&&!busy;
  let status=state.status,error='';
  if(!state.available)status='Unavailable';
  else if(busy) {
    const p=state.progress;
    status=p?`${p.direction==='upload'?'Upload':'Download'} ${p.path}: ${p.completed}/${p.total} chunks`:state.activity||'Working…';
  } else if(!state.connected)status='Not configured';
  else if(!state.ready){status='Unavailable';error=state.error;}
  else if(state.error){status='Sync failed';error=state.error;}
  else if(state.paused)status='Paused';
  else if(status==='Not configured')status='Ready';
  return {status,error,sync:network&&state.ready,preview:network&&state.ready,history:network&&state.ready,
    pause:state.available&&!busy,configuration:network&&state.configurationReady,
    review:network&&state.configurationReady&&state.configurationEnabled&&state.updates>0};
}
