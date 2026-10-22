import {expect,test,vi} from 'vitest';
import type {App,Workspace,WorkspaceLeaf} from 'obsidian';
import type {SyncEngine} from '../src/engine';
import type {ConfigurationSync} from '../src/configuration-sync';
import type {SidebarSnapshot} from '../src/sidebar-state';
import {emptyState} from '../src/types';

const ui=vi.hoisted(()=>{
  class Element {
    children:Element[]=[];text='';cls='';attrs:Record<string,string>={};hidden=false;disabled=false;inert=false;title='';
    parent?:Element;
    onclick?:()=>Promise<unknown>;tag:string;
    constructor(tag='div'){this.tag=tag;}
    createEl(tag:string,options:{text?:string;cls?:string;attr?:Record<string,string>}={}){
      const child=new Element(tag);child.text=options.text??'';child.cls=options.cls??'';child.attrs={...options.attr};child.parent=this;this.children.push(child);return child;
    }
    createDiv(options:{cls?:string;attr?:Record<string,string>}={}){return this.createEl('div',options);}
    setText(text:string){this.text=text;}
    addClass(cls:string){if(!this.cls.split(' ').includes(cls))this.cls+=' '+cls;}
    toggleClass(cls:string,value:boolean){if(value)this.addClass(cls);else this.cls=this.cls.split(' ').filter(name=>name!==cls).join(' ');}
    empty(){this.children=[];this.text='';}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    setAttribute(key:string,value:string){this.attrs[key]=value;}
    all():Element[]{return [this,...this.children.flatMap(child=>child.all())];}
  }
  return {Element};
});
vi.mock('obsidian',()=>({
  addIcon:vi.fn(),setIcon:vi.fn(),
  ItemView:class {
    app:App;contentEl=new ui.Element();cleanup:(()=>void)[]=[];
    constructor(leaf:WorkspaceLeaf){this.app=(leaf as unknown as {app:App}).app;}
    register(callback:()=>void){this.cleanup.push(callback);}
  },
  ButtonComponent:class {
    buttonEl:InstanceType<typeof ui.Element>;
    constructor(container:InstanceType<typeof ui.Element>){this.buttonEl=container.createEl('button');}
    setIcon(icon:string){this.buttonEl.attrs.icon=icon;this.buttonEl.attrs.iconSets=String(Number(this.buttonEl.attrs.iconSets??0)+1);return this;}
    setTooltip(text:string){this.buttonEl.attrs.tooltip=text;return this;}
    setClass(cls:string){this.buttonEl.cls=cls;return this;}
    setButtonText(text:string){this.buttonEl.text=text;return this;}
    setDisabled(value:boolean){this.buttonEl.disabled=value;return this;}
    setCta(){return this;}
    onClick(callback:()=>Promise<unknown>){this.buttonEl.onclick=callback;return this;}
  },
  Notice:class {constructor(){throw new Error('Popup notices are forbidden');}},
  Plugin:class {constructor(public app:App,public manifest:unknown){} async saveData(_value:unknown){}},
  PluginSettingTab:class {},Modal:class {constructor(){throw new Error('Modal dialogs are forbidden');}},
  Setting:class {
    settingEl:InstanceType<typeof ui.Element>;
    constructor(container:InstanceType<typeof ui.Element>){this.settingEl=container.createDiv();}
    setName(name:string){this.settingEl.createEl('span',{text:name});return this;}
    setDesc(text:string){this.settingEl.createEl('span',{text});return this;}
    addButton(build:(button:unknown)=>void){
      const el=this.settingEl.createEl('button');
      const button={buttonEl:el,setButtonText:(text:string)=>{el.text=text;return button;},setCta:()=>button,setDisabled:(value:boolean)=>{el.disabled=value;return button;},onClick:(callback:()=>Promise<unknown>)=>{el.onclick=callback;return button;}};
      build(button);return this;
    }
    addToggle(build:(toggle:unknown)=>void){
      const el=this.settingEl.createEl('input');let change:(value:boolean)=>unknown;
      const toggle={setValue:(value:boolean)=>{el.attrs.checked=String(value);return toggle;},onChange:(callback:(value:boolean)=>unknown)=>{change=callback;el.onclick=async()=>{await change(el.attrs.checked!=='true');};return toggle;}};
      build(toggle);return this;
    }
  },TFolder:class {},
  Platform:{isMacOS:true},requireApiVersion:()=>true,requestUrl:vi.fn(),
}));
import MindSync from '../src/main';
import {MINDSYNC_VIEW,MindSyncView,openSidebar,type SidebarHost} from '../src/sidebar';
import {sidebarPresentation} from '../src/sidebar-state';
import {showConfigurationSettings,showConfigurationUpdates,type ConfigurationUiHost} from '../src/configuration-ui';
import {defaultConfigurationSelection} from '../src/configuration-paths';
import type {PanelSession} from '../src/panel-page';

function snapshot():SidebarSnapshot {
  return {available:true,connected:true,ready:true,configurationReady:true,configurationEnabled:true,paused:false,busy:false,activityVisible:false,
    activity:'',status:'Synced',error:'',pending:0,configurationStatus:'Ready',updates:0,conflicts:[]};
}
function fixture(){
  const state=snapshot(),listeners=new Set<()=>void>();
  const host:SidebarHost={sidebarSnapshot:()=>state,subscribeSidebar:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    sync:vi.fn(async()=>{}),preview:vi.fn(async()=>{}),history:vi.fn(async()=>{}),togglePause:vi.fn(async()=>{}),
    manageConfiguration:vi.fn(),reviewConfiguration:vi.fn(async()=>{}),deleteConflict:vi.fn(async()=>{}),feedback:vi.fn((text,error=false)=>{state.feedback={text,error};for(const listener of listeners)listener();})};
  const workspace={openLinkText:vi.fn(async()=>{})};
  const view=new MindSyncView({app:{workspace}} as unknown as WorkspaceLeaf,host);
  const box=view.contentEl as unknown as InstanceType<typeof ui.Element>;
  const notify=()=>{for(const listener of listeners)listener();};
  const button=(label:string)=>box.all().find(el=>el.tag==='button'&&(el.attrs['aria-label']===label||el.text===label||(el.attrs['aria-label']??'').startsWith(label)))!;
  return {state,host,workspace,view,box,listeners,notify,button};
}
test('startup adds a separate native tab without replacing Git or revealing the sidebar',async()=>{
  const git={setViewState:vi.fn()},leaf={setViewState:vi.fn(async()=>{})};
  const workspace={getLeavesOfType:vi.fn((type:string)=>type===MINDSYNC_VIEW?[]:[git]),getRightLeaf:vi.fn(()=>leaf),revealLeaf:vi.fn()};
  await openSidebar(workspace as unknown as Workspace,false);
  expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
  expect(leaf.setViewState).toHaveBeenCalledWith({type:MINDSYNC_VIEW,active:false});
  expect(workspace.revealLeaf).not.toHaveBeenCalled();expect(git.setViewState).not.toHaveBeenCalled();
});
test('explicit open reuses and reveals a restored deferred leaf without accessing its view',async()=>{
  const leaf={get view(){throw new Error('deferred view must not be accessed');}};
  const workspace={getLeavesOfType:vi.fn(()=>[leaf]),getRightLeaf:vi.fn(),revealLeaf:vi.fn(async()=>{})};
  await openSidebar(workspace as unknown as Workspace);await openSidebar(workspace as unknown as Workspace);
  expect(workspace.getRightLeaf).not.toHaveBeenCalled();expect(workspace.revealLeaf).toHaveBeenCalledTimes(2);
});
test('simultaneous startup and explicit open create one leaf',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const leaf={setViewState:vi.fn(()=>gate)},workspace={getLeavesOfType:()=>[],getRightLeaf:vi.fn(()=>leaf),revealLeaf:vi.fn(async()=>{})};
  const start=openSidebar(workspace as unknown as Workspace,false),open=openSidebar(workspace as unknown as Workspace);
  release();await Promise.all([start,open]);expect(workspace.getRightLeaf).toHaveBeenCalledTimes(1);expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
});
test('failed leaf creation can be retried without a stuck opening promise',async()=>{
  const leaf={setViewState:vi.fn().mockRejectedValueOnce(new Error('layout unavailable')).mockResolvedValue(undefined)};
  const workspace={getLeavesOfType:()=>[],getRightLeaf:()=>leaf,revealLeaf:vi.fn(async()=>{})};
  await expect(openSidebar(workspace as unknown as Workspace)).rejects.toThrow('layout unavailable');
  await openSidebar(workspace as unknown as Workspace);expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
});
test('busy transfer takes precedence over pause and an old error',()=>{
  const state:SidebarSnapshot={...snapshot(),paused:true,busy:true,activityVisible:true,activity:'Syncing…',error:'old error',progress:{path:'large.pdf',direction:'upload',completed:2,total:8}};
  const view=sidebarPresentation(state);expect(view.status).toBe('Upload large.pdf: 2/8 chunks');expect(view.error).toBe('');expect(view.sync).toBe(false);
  state.busy=false;state.progress=undefined;
  expect(sidebarPresentation(state).status).toBe('Sync failed');state.error='';expect(sidebarPresentation(state).status).toBe('Paused');
});
test('a short background check keeps the previous badge and leaves actions enabled',()=>{
  const state:SidebarSnapshot={...snapshot(),busy:true,activityVisible:false,activity:'Syncing…'};
  expect(sidebarPresentation(state)).toMatchObject({status:'Synced',error:'',sync:true,preview:true,pause:true});
});
test('missing connection, missing engines and unload disable dependent actions',()=>{
  expect(sidebarPresentation({...snapshot(),connected:false})).toMatchObject({status:'Not configured',sync:false,history:false,configuration:false,pause:true});
  expect(sidebarPresentation({...snapshot(),ready:false,error:'journal unavailable'})).toMatchObject({status:'Unavailable',sync:false,error:'journal unavailable'});
  expect(sidebarPresentation({...snapshot(),configurationReady:false})).toMatchObject({sync:true,configuration:false,review:false});
  expect(sidebarPresentation({...snapshot(),available:false})).toMatchObject({status:'Unavailable',sync:false,pause:false,configuration:false});
});
test('opening the panel reads local state only and exposes accessible native controls',async()=>{
  const f=fixture();await f.view.onOpen();
  for(const method of ['sync','preview','history','togglePause','manageConfiguration','reviewConfiguration'] as const)expect(f.host[method]).not.toHaveBeenCalled();
  expect(f.box.all().some(el=>el.attrs.role==='toolbar'&&el.attrs['aria-label']==='MindSync actions')).toBe(true);
  expect(f.button('Sync now').attrs.tooltip).toBe('Sync now');expect(f.button('Pause automatic sync').attrs['aria-pressed']).toBe('false');
  expect(f.box.all().some(el=>el.text==='No conflicts')).toBe(true);
});
test('progress refresh preserves button identity and applies current guards even before repaint',async()=>{
  const f=fixture();await f.view.onOpen();const button=f.button('Sync now');
  f.state.busy=true;f.state.activityVisible=true;f.state.activity='Syncing…';await button.onclick!();expect(f.host.sync).not.toHaveBeenCalled();
  f.notify();expect(f.button('Sync now')).toBe(button);expect(button.disabled).toBe(true);
  f.state.busy=false;f.state.activityVisible=false;f.state.progress=undefined;f.notify();await button.onclick!();expect(f.host.sync).toHaveBeenCalledWith(true);
});
test('pause state and configuration review counts update without replacing toolbar controls',async()=>{
  const f=fixture();await f.view.onOpen();const pause=f.button('Pause automatic sync'),review=f.button('Review updates');
  expect(review.hidden).toBe(true);f.state.paused=true;f.state.updates=2;f.notify();
  expect(f.button('Resume automatic sync')).toBe(pause);expect(pause.attrs['aria-pressed']).toBe('true');expect(review.hidden).toBe(false);
  await pause.onclick!();await review.onclick!();expect(f.host.togglePause).toHaveBeenCalledOnce();expect(f.host.reviewConfiguration).toHaveBeenCalledOnce();
  f.state.configurationEnabled=false;f.notify();expect(review.disabled).toBe(true);
});
test('delete conflict copy removes the file and clears the entry',async()=>{
  const f=fixture();f.state.conflicts=[{path:'MindSync Conflicts/a.conflict.md',source:'a.md'}];await f.view.onOpen();
  await f.button('Delete').onclick!();
  expect(f.host.deleteConflict).toHaveBeenCalledWith('MindSync Conflicts/a.conflict.md');
});
test('conflict actions open tracked paths in Obsidian and do not invoke sync',async()=>{
  const f=fixture();f.state.conflicts=[{path:'note (conflict).md',source:'note.md'}];await f.view.onOpen();
  await f.button('Compare').onclick!();
  expect(f.workspace.openLinkText.mock.calls).toEqual([['note.md','',true],['note (conflict).md','',true]]);expect(f.host.sync).not.toHaveBeenCalled();
});
test('closing unsubscribes and an in-flight action cannot update a closed view',async()=>{
  const f=fixture();let reject!:(error:Error)=>void;
  vi.mocked(f.host.sync).mockImplementation(()=>new Promise<void>((_resolve,rejectPromise)=>{reject=rejectPromise;}));
  await f.view.onOpen();const button=f.button('Sync now'),pending=button.onclick!();
  await f.view.onClose();expect(f.listeners.size).toBe(0);f.notify();reject(new Error('late failure'));await pending;
  expect(f.box.children).toEqual([]);expect(f.host.feedback).not.toHaveBeenCalled();
  await button.onclick!();expect(f.host.sync).toHaveBeenCalledTimes(1);
  await f.view.onOpen();expect(f.listeners.size).toBe(1);await f.view.onClose();expect(f.listeners.size).toBe(0);
});
test('native component unload disposes its view subscription',async()=>{
  const f=fixture();await f.view.onOpen();
  for(const cleanup of (f.view as unknown as {cleanup:(()=>void)[]}).cleanup)cleanup();
  expect(f.listeners.size).toBe(0);await f.button('Sync now').onclick!();expect(f.host.sync).not.toHaveBeenCalled();
});
test('plugin notifications show running and final state, and unsubscribe stops delivery',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';plugin.settings.paused=true;
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});const state=emptyState();
  plugin.engine={state,setDeviceName:()=>{},sync:async()=>{await gate;state.lastSuccess='2026-10-14T11:30:00Z';}} as unknown as SyncEngine;
  const states:SidebarSnapshot[]=[],stop=plugin.subscribeSidebar(()=>states.push(plugin.sidebarSnapshot()));
  const run=plugin.sync(true);expect(states[0]).toMatchObject({busy:true,activity:'Syncing…',paused:true});
  finish();await run;expect(states.at(-1)).toMatchObject({busy:false,status:'Synced',lastSuccess:'2026-10-14T11:30:00Z'});
  const count=states.length;stop();await plugin.togglePause();expect(states.length).toBe(count);expect(plugin.settings.paused).toBe(false);
  expect(plugin.settings.token).toBe('fixture-token');
});
test('failed pause persistence retains active settings and reports the failure in the panel',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);const state=plugin.sidebarSnapshot();
  vi.spyOn(plugin,'saveData').mockRejectedValue(new Error('disk full'));
  const f=fixture();f.host.togglePause=()=>plugin.togglePause();await f.view.onOpen();
  await f.button('Pause automatic sync').onclick!();expect(plugin.settings.paused).toBe(state.paused);
  expect(f.host.feedback).toHaveBeenCalledWith('disk full',true);expect(f.box.all().some(el=>el.text==='disk full'&&el.attrs.role==='alert')).toBe(true);
});
test('fast background syncs finish without flashing an activity badge',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
  plugin.engine={state:emptyState(),sync:async()=>{}} as unknown as SyncEngine;
  const states:SidebarSnapshot[]=[];plugin.subscribeSidebar(()=>states.push(plugin.sidebarSnapshot()));
  await plugin.sync();
  expect(plugin.sidebarSnapshot()).toMatchObject({busy:false,activityVisible:false,status:'Synced'});
  expect(states.some(state=>state.activityVisible)).toBe(false);
});
test('a slow sync reveals activity only after the threshold',async()=>{
  vi.useFakeTimers();
  try{
    const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    plugin.engine={state:emptyState(),sync:async()=>{await gate;}} as unknown as SyncEngine;
    const run=plugin.sync();
    await vi.advanceTimersByTimeAsync(799);
    expect(plugin.sidebarSnapshot().activityVisible).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(plugin.sidebarSnapshot()).toMatchObject({busy:true,activityVisible:true,activity:'Syncing…'});
    release();await run;
    expect(plugin.sidebarSnapshot()).toMatchObject({busy:false,activityVisible:false,status:'Synced'});
  }finally{vi.useRealTimers();}
});
test('unload clears a pending activity timer',async()=>{
  vi.useFakeTimers();
  try{
    const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    plugin.engine={state:emptyState(),sync:async()=>{await gate;}} as unknown as SyncEngine;
    const run=plugin.sync();plugin.onunload();await vi.advanceTimersByTimeAsync(1000);
    expect(plugin.sidebarSnapshot()).toMatchObject({available:false,activityVisible:false});
    release();await run;
  }finally{vi.useRealTimers();}
});
test('every sub-page exposes a back control that honours its return target',async()=>{
  const f=fixture();await f.view.onOpen();const back=f.button('Back');
  expect(back.hidden).toBe(true);
  let returned=false;
  await f.view.showPage(()=>{},'configuration',()=>{returned=true;});
  expect(back.hidden).toBe(false);
  await back.onclick!();expect(returned).toBe(true);
  await f.view.showOverview();expect(back.hidden).toBe(true);
});
test('the open sub-page keeps its toolbar entry highlighted until it is clicked again',async()=>{
  const f=fixture();await f.view.onOpen();
  const history=f.button('File history');
  await f.view.showPage(()=>{},'history');
  expect(history.attrs['aria-current']).toBe('page');
  await f.button('File history').onclick!();
  expect(history.attrs['aria-current']).toBe('false');
});
test('a background check that is still short leaves toolbar controls enabled',async()=>{
  const f=fixture();await f.view.onOpen();const button=f.button('Sync now');
  f.state.busy=true;f.state.activity='Syncing…';f.notify();
  expect(button.disabled).toBe(false);
  f.state.activityVisible=true;f.state.activity='Syncing…';f.state.progress={path:'note.md',direction:'upload',completed:1,total:2};f.notify();
  expect(button.disabled).toBe(true);
});
test('repeated refreshes do not rebuild the pause control',async()=>{
  const f=fixture();await f.view.onOpen();const pause=f.button('Pause automatic sync');
  const count=pause.attrs.iconSets;
  f.state.lastSuccess='2026-10-14T11:30:00Z';f.notify();f.notify();
  expect(pause.attrs.iconSets).toBe(count);
  f.state.paused=true;f.notify();expect(pause.attrs.iconSets).not.toBe(count);
});
test('configuration work and unload notify subscribers without a new network poll',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
  let updates=0;const stop=vi.fn();plugin.configuration={updates:()=>Array(updates).fill({}),local:{state:{}},stop} as unknown as ConfigurationSync;
  const snapshots:SidebarSnapshot[]=[];plugin.subscribeSidebar(()=>snapshots.push(plugin.sidebarSnapshot()));
  await plugin.runConfiguration(async()=>{updates=2;});
  expect(snapshots[0]).toMatchObject({busy:true,activity:'Syncing configuration…'});expect(snapshots.at(-1)).toMatchObject({busy:false,updates:2});
  plugin.onunload();expect(snapshots.at(-1)?.available).toBe(false);expect(stop).toHaveBeenCalledOnce();
  const count=snapshots.length;await plugin.togglePause();expect(snapshots.length).toBe(count);
});
test('a failing view observer cannot turn a durable settings save into a failure',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never),error=new Error('view unavailable');
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const stop=plugin.subscribeSidebar(()=>{throw error;});
  try{await plugin.togglePause();expect(plugin.settings.paused).toBe(true);expect(log).toHaveBeenCalledWith('MindSync sidebar update failed',error);}
  finally{stop();log.mockRestore();}
});
test('inline pages return to overview and invalidate pending results without reopening',async()=>{
  const f=fixture();await f.view.onOpen();let release!:()=>void,session!:PanelSession;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const pending=f.view.showPage(async(box,current)=>{session=current;await gate;if(current.active())box.createEl('p',{text:'late result'});},'preview');
  await f.button('Preview sync').onclick!();
  release();await pending;expect(session.active()).toBe(false);expect(f.box.all().some(el=>el.text==='late result')).toBe(false);
  expect(f.box.all().some(el=>el.text==='Conflicts')).toBe(true);
});
test('progress and inline feedback preserve an active page and its unsaved controls',async()=>{
  const f=fixture();await f.view.onOpen();let content!:HTMLElement;
  await f.view.showPage((box)=>{content=box;box.createEl('input',{attr:{value:'unsaved draft'}});});
  const input=(content as unknown as InstanceType<typeof ui.Element>).children[0];
  f.state.busy=true;f.state.activity='Syncing…';f.notify();f.host.feedback('disk full',true);
  expect((content as unknown as InstanceType<typeof ui.Element>).children[0]).toBe(input);
  expect(input.attrs.value).toBe('unsaved draft');expect(f.box.all().some(el=>el.text==='disk full'&&el.attrs.role==='alert')).toBe(true);
});
function pagePlugin(f:ReturnType<typeof fixture>){
  const plugin=new MindSync({workspace:{getActiveFile:()=>null}} as unknown as App,{id:'mindsync'} as never);
  plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
  vi.spyOn(plugin,'openPage').mockImplementation((title,render)=>f.view.showPage(render,title==='Sync preview'?'preview':title.startsWith('History')?'history':title==='Settings and plugins'?'configuration':undefined));return plugin;
}
test('preview approval remains explicit and rejects changed credentials without a modal',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  plugin.engine={state:emptyState(),preview:async()=>[{action:'upload',path:'note.md'}]} as unknown as SyncEngine;
  const sync=vi.spyOn(plugin,'sync').mockResolvedValue();await plugin.preview();expect(sync).not.toHaveBeenCalled();
  plugin.settings.token='changed-token';await f.button('Sync this plan').onclick!();expect(sync).not.toHaveBeenCalled();
  expect(plugin.sidebarSnapshot().feedback?.error).toBe(true);plugin.settings.token='fixture-token';await f.button('Sync this plan').onclick!();expect(sync).toHaveBeenCalledWith(true,true);
});
test('leaving a loading preview does not populate or reopen it when the request returns',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);let release!:(items:[])=>void;
  plugin.engine={state:emptyState(),preview:()=>new Promise<[]>((resolve)=>{release=resolve;})} as unknown as SyncEngine;
  const pending=plugin.preview();await Promise.resolve();await f.button('Preview sync').onclick!();release([]);await pending;
  expect(f.box.all().some(el=>el.text==='Sync this plan')).toBe(false);expect(plugin.sidebarSnapshot().busy).toBe(false);
});
test('history restores only after explicit selection and rejects changed server identity',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f),state=emptyState();
  state.files.note={id:'note',path:'note.md',revision:1,hash:'a'.repeat(64),size:1,deleted:false};
  const restore=vi.fn(async()=>{});plugin.engine={state,restore} as unknown as SyncEngine;
  plugin.api={history:async()=>({versions:[{revision:1,deleted:false,size:1}]})} as never;
  await plugin.history();await f.button('View history').onclick!();expect(restore).not.toHaveBeenCalled();
  plugin.settings.server='https://changed.example';await f.button('Restore').onclick!();expect(restore).not.toHaveBeenCalled();
  expect(plugin.sidebarSnapshot().feedback?.text).toContain('Open file history again');
});
test('configuration selection uses inline Save changes and keeps the active selection untouched until saved',async()=>{
  const f=fixture();await f.view.onOpen();let selection=defaultConfigurationSelection();
  const save=vi.fn(async(value)=>{selection=value;});
  const host:ConfigurationUiHost={openPage:(_title,render)=>f.view.showPage(render,'configuration'),feedback:f.host.feedback,configurationStatus:'Disabled',
    configurationSelection:()=>selection,saveConfigurationSelection:save,runConfiguration:async(work)=>work()};
  await showConfigurationSettings(host);const toggle=f.box.all().find(el=>el.tag==='input')!;await toggle.onclick!();
  expect(selection.enabled).toBe(false);expect(save).not.toHaveBeenCalled();await f.button('Save changes').onclick!();
  expect(selection.enabled).toBe(true);expect(save).toHaveBeenCalledOnce();expect(f.host.feedback).toHaveBeenCalledWith('Changes saved');
});
test('late configuration review results are discarded after Back',async()=>{
  const f=fixture();await f.view.onOpen();let release!:(value:[])=>void;
  const host:ConfigurationUiHost={openPage:(_title,render)=>f.view.showPage(render,'configuration'),feedback:f.host.feedback,configurationStatus:'Ready',
    configurationSelection:defaultConfigurationSelection,saveConfigurationSelection:async()=>{},runConfiguration:async(work)=>work(),
    configuration:{review:()=>new Promise<[]>((resolve)=>{release=resolve;})} as unknown as ConfigurationSync};
  const pending=showConfigurationUpdates(host);await f.button('Settings and plugins').onclick!();release([]);await pending;
  expect(f.box.all().some(el=>el.text==='Apply selected')).toBe(false);expect(f.host.feedback).not.toHaveBeenCalled();
});
test('manual sync reports success inline with Notice and Modal constructors forbidden',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
  plugin.engine={state:emptyState(),sync:async()=>{}} as unknown as SyncEngine;
  await plugin.sync(true);expect(plugin.sidebarSnapshot().feedback).toEqual({text:'Sync completed',error:false});
});
test('inline configuration approval keeps complete plugin groups and applies only selected groups',async()=>{
  const f=fixture();await f.view.onOpen();
  const updates=['plugins/example/main.js','plugins/example/data.json','app.json'].map((path,index)=>({file:{path,revision:index+1,deleted:false},conflict:false}));
  const apply=vi.fn(async()=>2);
  const host:ConfigurationUiHost={openPage:(_title,render)=>f.view.showPage(render,'configuration'),feedback:f.host.feedback,configurationStatus:'Ready',
    configurationSelection:defaultConfigurationSelection,saveConfigurationSelection:async()=>{},runConfiguration:async(work)=>work(),
    configuration:{review:async()=>updates,apply,local:{state:{conflicts:[]}}} as unknown as ConfigurationSync};
  await showConfigurationUpdates(host);expect(apply).not.toHaveBeenCalled();
  const toggles=f.box.all().filter(el=>el.tag==='input');expect(toggles.length).toBe(2);await toggles[1].onclick!();
  await f.button('Apply selected').onclick!();expect(apply).toHaveBeenCalledWith(updates.slice(0,2));
  expect(f.host.feedback).toHaveBeenCalledWith('Applied 2 configuration files. Reload Obsidian.');
});
test('failed preview removes its loading indicator and shows the actual path error inline',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  plugin.engine={state:emptyState(),preview:async()=>{throw new Error('Unsupported path: folder: title/note.md');}} as unknown as SyncEngine;
  await plugin.preview();expect(f.box.all().some(el=>el.text==='Loading preview…')).toBe(false);
  expect(plugin.sidebarSnapshot()).toMatchObject({busy:false,feedback:{text:'Unsupported path: folder: title/note.md',error:true}});
  expect(f.box.all().some(el=>el.text==='Sync this plan')).toBe(false);
});
test('failed history removes its loading indicator without offering a restore',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f),state=emptyState();
  state.files.note={id:'note',path:'note.md',revision:1,hash:'a'.repeat(64),size:1,deleted:false};
  plugin.engine={state} as unknown as SyncEngine;plugin.api={history:async()=>{throw new Error('offline');}} as never;
  await plugin.history();await f.button('View history').onclick!();
  expect(f.box.all().some(el=>el.text==='Loading history…')).toBe(false);
  expect(f.box.all().some(el=>el.text==='Restore')).toBe(false);expect(plugin.sidebarSnapshot().busy).toBe(false);
});

test('history groups files by folder and collapses directories',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  const state=emptyState();
  const file=(id:string,path:string,revision:number)=>({id,path,revision,hash:'a'.repeat(64),size:1,deleted:false});
  state.files.a=file('a','bugs/a.md',1);
  state.files.b=file('b','bugs/deep/b.md',2);
  state.files.c=file('c','curiosity/c.md',3);
  plugin.engine={state} as unknown as SyncEngine;
  plugin.api={history:async()=>({versions:[]})} as never;
  await plugin.history();
  expect(f.box.all().some(el=>el.text==='Vault')).toBe(true);
  expect(f.box.all().some(el=>(el.attrs['aria-label']??'')==='bugs')).toBe(true);
  expect(f.box.all().some(el=>(el.attrs['aria-label']??'').startsWith('View history of curiosity/c.md'))).toBe(true);
  const folder=f.box.all().find(el=>(el.attrs['aria-label']??'')==='bugs')!;
  await folder.onclick!();
  expect(folder.attrs['aria-expanded']).toBe('false');
  await folder.onclick!();
  expect(folder.attrs['aria-expanded']).toBe('true');
});

test('history remembers collapsed folders across visits',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  const state=emptyState();
  const file=(id:string,path:string,revision:number)=>({id,path,revision,hash:'a'.repeat(64),size:1,deleted:false});
  state.files.a=file('a','bugs/a.md',1);
  state.files.b=file('b','bugs/b.md',2);
  plugin.engine={state} as unknown as SyncEngine;
  plugin.api={history:async()=>({versions:[]})} as never;
  await plugin.history();
  const folder=()=>f.box.all().find(el=>(el.attrs['aria-label']??'')==='bugs')!;
  await folder().onclick!();
  const stored=(plugin as unknown as {collapsedHistory:Set<string>}).collapsedHistory;
  expect(stored.has('vault:bugs')).toBe(true);
  await plugin.history();
  expect(folder().attrs['aria-expanded']).toBe('false');
  await folder().onclick!();
  expect(stored.has('vault:bugs')).toBe(false);
  expect(folder().attrs['aria-expanded']).toBe('true');
});

test('conflict copies are grouped outside the vault tree',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  const state=emptyState();
  const file=(id:string,path:string,revision:number)=>({id,path,revision,hash:'a'.repeat(64),size:1,deleted:false});
  state.files.a=file('a','note.md',1);
  state.files.b=file('b','MindSync Conflicts/note.md',2);
  state.files.c=file('c','MindSync Conflicts 2/folder/note.md',3);
  plugin.engine={state} as unknown as SyncEngine;
  plugin.api={history:async()=>({versions:[]})} as never;
  await plugin.history();
  const all=f.box.all();
  expect(all.some(el=>el.text==='Conflicts')).toBe(true);
  expect(all.some(el=>(el.attrs['aria-label']??'')==='MindSync Conflicts')).toBe(false);
  expect(all.some(el=>(el.attrs['aria-label']??'').startsWith('View history of MindSync Conflicts/note.md'))).toBe(true);
  expect(all.some(el=>(el.attrs['aria-label']??'')==='folder')).toBe(true);
});

test('preview confirm button disables while a sync owns the lock',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  plugin.engine={state:emptyState(),preview:async()=>[{action:'upload',path:'note.md'}]} as unknown as SyncEngine;
  await plugin.preview();
  const confirm=()=>f.box.all().find(el=>el.tag==='button'&&el.text==='Sync this plan')!;
  expect(confirm().disabled).toBe(false);
  (plugin as unknown as {busy:boolean}).busy=true;
  (plugin as unknown as {notifySidebar:()=>void}).notifySidebar();
  expect(confirm().disabled).toBe(true);
  expect(String(confirm().title)).toContain('already running');
  (plugin as unknown as {busy:boolean}).busy=false;
  (plugin as unknown as {notifySidebar:()=>void}).notifySidebar();
  expect(confirm().disabled).toBe(false);
});

test('an automatic configuration check waits quietly while a note sync runs',async()=>{
  const f=fixture();await f.view.onOpen();const plugin=pagePlugin(f);
  (plugin as unknown as {busy:boolean}).busy=true;
  const work=vi.fn(async()=>1);
  const before=plugin.sidebarSnapshot().configurationStatus;
  await plugin.runConfiguration(work,false);
  expect(work).not.toHaveBeenCalled();
  expect(plugin.sidebarSnapshot().configurationStatus).toBe(before);
  await plugin.runConfiguration(work,true);
  expect(plugin.sidebarSnapshot().feedback?.error).toBe(true);
  expect(plugin.sidebarSnapshot().configurationStatus).toContain('Another sync');
});
