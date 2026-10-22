import {App, Platform, Plugin, PluginSettingTab, requestUrl, requireApiVersion, setIcon, Setting, TAbstractFile, TFolder, type ButtonComponent} from 'obsidian';
import {Api} from './api';
import {ConnectionContext,type Connection,type ConnectedHttp} from './connection';
import {SyncEngine} from './engine';
import {ObsidianLocal} from './local';
import {FileRecord, included, SyncError} from './types';
import {ConfigurationLocal} from './configuration-local';
import {ConfigurationSync} from './configuration-sync';
import {ConfigurationSelection, defaultConfigurationSelection} from './configuration-paths';
import {showConfigurationSettings,showConfigurationUpdates} from './configuration-ui';
import {Settings, SettingsDraft, SettingsStore, connectionSettings} from './settings';
import {MINDSYNC_VIEW,MindSyncView,openSidebar} from './sidebar';
import type {SidebarAction,SidebarSnapshot} from './sidebar-state';
import type {PanelRenderer} from './panel-page';
import {registerMindSyncIcon} from './icon';
// Report form factor and OS so the server can show phones, tablets, and desktops
// with distinct icons instead of one generic device.
const CLIENT_PLATFORM=(()=>{
  const os=Platform.isIosApp?'ios':Platform.isAndroidApp?'android':Platform.isMacOS?'macos':Platform.isWin?'windows':Platform.isLinux?'linux':'unknown';
  const form=Platform.isPhone?'phone':Platform.isTablet?'tablet':Platform.isMobile?'mobile':'desktop';
  return `${form}-${os}`;
})();
// Keep the toolbar entry point highlighted while its sub-page is open, so the page stays
// identifiable after the pointer leaves the icon and its tooltip disappears.
function pageAction(title:string):SidebarAction|undefined {
  if(title==='Sync preview')return 'preview';
  if(title==='File history'||title.startsWith('History: '))return 'history';
  if(title==='Settings and plugins'||title==='Publish selected settings'||title==='Review configuration updates')return 'configuration';
}
// A workspace-style history row: file icon, name, folder, revision badge.
function fileHistoryRow(list:HTMLElement, path:string, revision:number, deleted:boolean, open:()=>Promise<unknown>, showFolder=true) {
  const slash=path.lastIndexOf('/');
  const name=slash<0?path:path.slice(slash+1);
  const folder=slash<0?'':path.slice(0,slash);
  const row=list.createEl('li',{cls:'mindsync-file-row'});
  const entry=row.createEl('button',{cls:'mindsync-file-entry',attr:{type:'button','aria-label':`View history of ${path}`,title:path}});
  setIcon(entry.createEl('span',{cls:'mindsync-file-icon'}),'file-text');
  const text=entry.createEl('span',{cls:'mindsync-file-text'});
  text.createEl('span',{cls:'mindsync-file-name',text:name});
  if(folder&&showFolder)text.createEl('span',{cls:'mindsync-file-meta',text:folder});
  const badge=entry.createEl('span',{cls:'mindsync-file-badge'});
  badge.setText(deleted?'Deleted':`R${revision}`);
  if(deleted)badge.addClass('is-deleted');
  setIcon(entry.createEl('span',{cls:'mindsync-file-chevron'}),'chevron-right');
  entry.onclick=open;
}

type HistoryEntry={path:string;revision:number;deleted?:boolean};
interface HistoryNode<T> { name:string; path:string; children:Map<string,HistoryNode<T>>; file?:T; files:number }
interface HistoryTreeState { collapsed:Set<string>; save:()=>void }

// Group history entries by their path segments, then render collapsible folders.
// Folder state is keyed by namespace and path so it survives reopening the page.
function renderHistoryTree<T extends HistoryEntry>(box:HTMLElement, files:T[], open:(file:T)=>Promise<unknown>, prefix='', namespace='', state?:HistoryTreeState, stripRoot=false) {
  const root:HistoryNode<T>={name:'',path:'',children:new Map(),files:0};
  for(const file of files){
    const parts=file.path.slice(prefix.length).split('/').filter(Boolean);
    if(stripRoot)parts.shift();
    let node=root;
    for(let index=0;index<parts.length;index++){
      const part=parts[index];
      let child=node.children.get(part);
      if(!child){child={name:part,path:parts.slice(0,index+1).join('/'),children:new Map(),files:0};node.children.set(part,child);}
      node=child;
    }
    node.file=file;
  }
  const count=(node:HistoryNode<T>):number=>{let total=node.file?1:0;for(const child of node.children.values())total+=count(child);node.files=total;return total;};
  count(root);
  const list=box.createEl('ul',{cls:'mindsync-file-list mindsync-file-tree'});
  const render=(parent:HTMLElement,node:HistoryNode<T>)=>{
    const children=[...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name));
    for(const child of children){
      if(child.children.size===0&&child.file){
        fileHistoryRow(parent,child.file.path,child.file.revision,!!child.file.deleted,()=>open(child.file!),false);
        continue;
      }
      const key=namespace?`${namespace}:${child.path}`:child.path;
      const isCollapsed=state?.collapsed.has(key)??false;
      const item=parent.createEl('li',{cls:'mindsync-tree-dir'});
      const toggle=item.createEl('button',{cls:`mindsync-tree-toggle${isCollapsed?'':' is-expanded'}`,attr:{type:'button','aria-expanded':String(!isCollapsed),'aria-label':child.name,title:child.name}});
      setIcon(toggle.createEl('span',{cls:'mindsync-tree-chevron'}),'chevron-right');
      setIcon(toggle.createEl('span',{cls:'mindsync-tree-icon'}),'folder');
      toggle.createEl('span',{cls:'mindsync-tree-name',text:child.name});
      toggle.createEl('span',{cls:'mindsync-tree-count',text:String(child.files)});
      const nested=item.createEl('ul',{cls:'mindsync-tree-children'});
      if(isCollapsed)nested.hidden=true;
      toggle.onclick=()=>{
        const collapsed=!nested.hidden;
        nested.hidden=collapsed;
        toggle.toggleClass('is-expanded',!collapsed);
        toggle.setAttribute('aria-expanded',String(!collapsed));
        if(state){
          if(collapsed)state.collapsed.add(key);else state.collapsed.delete(key);
          state.save();
        }
      };
      render(nested,child);
    }
  };
  render(list,root);
}

// Vault notes, settings, and plugins each get their own section.
function renderConfigurationTree<T extends HistoryEntry>(box:HTMLElement, files:T[], open:(file:T)=>Promise<unknown>, state?:HistoryTreeState) {
  if(!files.length){box.createEl('p',{text:'No synced settings have history yet'});return;}
  const settings=files.filter(file=>!file.path.startsWith('plugins/'));
  const plugins=files.filter(file=>file.path.startsWith('plugins/'));
  if(settings.length){box.createEl('h3',{text:'Settings'});renderHistoryTree(box,settings,open,'','settings',state);}
  if(plugins.length){box.createEl('h3',{text:'Plugins'});renderHistoryTree(box,plugins,open,'plugins/','plugins',state);}
}

function formatBytes(bytes:number){
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
export default class MindSync extends Plugin {
  settings: Settings = {server:'',token:'',deviceName:Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'Mac' : 'PC',paused:false,configuration:defaultConfigurationSelection()};
  private connection=new ConnectionContext(()=>this.settings);
  private settingsStore=new SettingsStore(()=>this.settings,value=>this.saveData(value),value=>{
    const previous=this.settings;this.settings=value;this.engine?.setDeviceName(value.deviceName);
    this.nextRetry=0;this.configurationRetry=0;
    if(previous.configuration!==value.configuration)this.configurationStatus=value.configuration.enabled?'Ready':'Disabled';
    this.notifySidebar();
  });
  engine?: SyncEngine; local?: ObsidianLocal; api!: Api;
  configuration?: ConfigurationSync; configurationStatus='Not configured';
  private unloading=false; private configurationRetry=0;
  status = 'Not configured'; lastError = ''; private busy = false; private failures = 0; private nextRetry = 0;
  // Automatic polls usually finish in well under a second. Only surface activity once it is long
  // enough to be worth a status change, so the badge does not flash on every background check.
  private activityVisible = false;
  private activityTimer?: ReturnType<typeof setTimeout>;
  private timeout?: number;
  private activity='';
  private panelFeedback?:{text:string;error:boolean};
  private sidebarListeners=new Set<()=>void>();
  private collapsedHistory=new Set<string>();
  private loadHistoryState(){
    try{
      const saved=this.app.loadLocalStorage?.('mindsync-history');
      if(Array.isArray(saved))this.collapsedHistory=new Set(saved.filter((key):key is string=>typeof key==='string'));
    }catch{/* Local storage is unavailable in tests and some restricted environments. */}
  }
  private saveHistoryState(){
    try{this.app.saveLocalStorage?.('mindsync-history',[...this.collapsedHistory]);}catch{/* Best effort only. */}
  }
  sidebarSnapshot():SidebarSnapshot {
    return {available:!this.unloading,connected:!!this.settings.server&&!!this.settings.token,ready:!!this.engine,
      configurationReady:!!this.configuration,configurationEnabled:this.settings.configuration.enabled,
      paused:this.settings.paused,busy:this.busy,activityVisible:this.activityVisible,activity:this.activity,status:this.status,error:this.lastError,
      progress:this.engine?.progress,lastSuccess:this.engine?.state.lastSuccess,pending:this.engine?.state.pending.length??0,
      configurationStatus:this.configurationStatus,updates:this.configuration?.updates().length??0,
      conflicts:(this.engine?.state.conflicts??[]).map(path=>({path,source:this.engine?.state.conflictDetails?.[path]?.source,device:this.engine?.state.conflictDetails?.[path]?.device,time:this.engine?.state.conflictDetails?.[path]?.time})),feedback:this.panelFeedback};
  }
  subscribeSidebar(listener:()=>void){this.sidebarListeners.add(listener);return ()=>{this.sidebarListeners.delete(listener);};}
  private notifySidebar(){for(const listener of this.sidebarListeners){try{listener();}catch(error){console.error('MindSync sidebar update failed',error);}}}
  private setBusy(busy:boolean,activity=''){
    this.busy=busy;this.activity=activity;if(busy)this.panelFeedback=undefined;
    if(this.activityTimer){clearTimeout(this.activityTimer);this.activityTimer=undefined;}
    if(!busy)this.activityVisible=false;
    else if(!this.activityVisible)this.activityTimer=setTimeout(()=>{this.activityTimer=undefined;this.activityVisible=true;this.notifySidebar();},800);
    this.notifySidebar();
  }
  feedback(text:string,error=false){this.panelFeedback={text,error};this.notifySidebar();}
  async togglePause(){await this.updateSettings(current=>({paused:!current.paused}));}
  async deleteConflict(path:string){
    if(this.unloading)return;
    const file=this.app.vault.getAbstractFileByPath(path);
    if(file)await this.app.vault.delete(file,true);
    await this.engine?.discardConflict(path);
    if(!this.unloading)this.notifySidebar();
  }
  manageConfiguration(){return showConfigurationSettings(this);}
  async reviewConfiguration(){await showConfigurationUpdates(this);}
  private async openPanel(reveal=true){if(this.unloading)return;try{await openSidebar(this.app.workspace,reveal);}catch(error){if(!this.unloading)this.feedback(error instanceof Error?error.message:String(error),true);}}
  async openPage(title:string,render:PanelRenderer,back?:()=>void){
    if(this.unloading)return;
    try{const leaf=await openSidebar(this.app.workspace);if(!this.unloading&&leaf?.view instanceof MindSyncView)await leaf.view.showPage(render,pageAction(title),back);}
    catch(error){if(!this.unloading)this.feedback(error instanceof Error?error.message:String(error),true);}
  }
  async onload() {
    this.loadHistoryState();
    this.settings = {...this.settings,...await this.loadData()};
    this.settings.configuration={...defaultConfigurationSelection(),...this.settings.configuration};
    registerMindSyncIcon();
    this.registerView(MINDSYNC_VIEW,leaf=>new MindSyncView(leaf,this));
    this.addCommand({id:'open-panel',name:'Open MindSync',callback:()=>void this.openPanel()});
    this.addCommand({id:'sync',name:'Sync now',callback:()=>void this.sync(true)});
    this.addCommand({id:'preview',name:'Preview sync plan',callback:()=>void this.preview()});
    this.addCommand({id:'status',name:'View status and conflicts',callback:()=>this.showStatus()});
    this.addCommand({id:'pause',name:'Pause or resume sync',callback:()=>this.togglePause()});
    this.addCommand({id:'history',name:'View file history',callback:()=>void this.history()});
    this.addCommand({id:'configuration',name:'Sync settings and plugins',callback:()=>showConfigurationSettings(this)});
    this.addSettingTab(new NasSettings(this.app,this));
    try {
      this.local = new ObsidianLocal(this.app,`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      this.api = this.makeApi(); const state = await this.local.load();
      this.engine = new SyncEngine(state,this.local,this.api,this.settings.deviceName);
      this.engine.onProgress=progress=>{if(progress){this.status=`${progress.direction==='upload'?'Upload':'Download'} ${progress.path}: ${progress.completed}/${progress.total} chunks`;this.activityVisible=true;if(this.activityTimer){clearTimeout(this.activityTimer);this.activityTimer=undefined;}}this.notifySidebar();};
    } catch(e) { this.report(e); }
    try {
      const configDir=this.app.vault.configDir;
      const local=new ConfigurationLocal(this.app.vault.adapter,configDir,`${configDir}/plugins/${this.manifest.id}/configuration-sync`);
      await local.load();
      this.configuration=new ConfigurationSync(local,this.makeApi(undefined,'configuration'),()=>this.settings.configuration,Platform.isMobile,requireApiVersion);
      this.configurationStatus=local.state.recoveryNotice??(this.settings.configuration.enabled?'Ready':'Disabled');
    } catch(error) { this.configurationStatus=error instanceof Error?error.message:String(error); }
    const changed = (file: TAbstractFile) => { if (!this.local?.writing && included(file.path,this.app.vault.configDir)) this.schedule(); };
    this.registerEvent(this.app.vault.on('create',changed));
    this.registerEvent(this.app.vault.on('modify',changed));
    this.registerEvent(this.app.vault.on('delete',changed));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{
      if (this.local?.writing || !included(old,this.app.vault.configDir)) return;
      if (file instanceof TFolder) {
        for (const record of Object.values(this.engine?.state.files ?? {})) if(record.path.startsWith(`${old}/`)) void this.engine?.renamed(record.path,`${file.path}${record.path.slice(old.length)}`).catch(e=>this.report(e));
      } else { void this.engine?.renamed(old,file.path).catch(e=>this.report(e)); }
      this.schedule();
    }));
    this.registerDomEvent(document,'visibilitychange',()=>{if(!document.hidden) { if(Number.isFinite(this.nextRetry)) this.nextRetry=0; void this.sync().then(()=>this.syncConfiguration()); }});
    this.registerInterval(window.setInterval(()=>{if(!document.hidden) void this.sync();},5000));
    this.registerInterval(window.setInterval(()=>{if(!document.hidden)void this.syncConfiguration();},30000));
    this.notifySidebar();
    this.app.workspace.onLayoutReady(()=>{void this.openPanel(false);void this.sync().then(()=>this.syncConfiguration());});
  }
  onunload(){this.unloading=true;this.configuration?.stop();if(this.timeout)window.clearTimeout(this.timeout);if(this.activityTimer){clearTimeout(this.activityTimer);this.activityTimer=undefined;}this.notifySidebar();this.sidebarListeners.clear();}
  private makeApi(token?: string, scope: 'notes' | 'configuration' = 'notes', fixed?:Connection) {
    const send:ConnectedHttp=async(connection,method,path,body)=>{
      const url = new URL(connection.server);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SyncError('INVALID_URL','Use an HTTP or HTTPS server URL without credentials, query parameters, or fragments');
      const base = connection.server.replace(/\/+$/,'');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request=requestUrl({url:base+path,method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':body instanceof Uint8Array ? 'application/octet-stream':'application/json','X-MindSync-Client':this.manifest.version,'X-MindSync-Platform':CLIENT_PLATFORM},body:body instanceof Uint8Array ? body.slice().buffer : body,throw:false});
      const reply=await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SyncError('TIMEOUT','Request timed out. Pending operations will be retained and retried')),path.startsWith('/v1/chunks/') ? 30000 : 120000);})]).finally(()=>{if(timer)clearTimeout(timer);});
      return {status:reply.status,body:reply.arrayBuffer};
    };
    return new Api(fixed?(method,path,body)=>send({...fixed,token:token??fixed.token},method,path,body):this.connection.http(send,token),scope);
  }
  updateSettings(patch:Partial<Settings>|((current:Settings)=>Partial<Settings>),expected?:Partial<Settings>){return this.settingsStore.update(patch,expected);}
  configurationSelection(){return this.settings.configuration;}
  async saveConfigurationSelection(selection:ConfigurationSelection,expected?:ConfigurationSelection){await this.updateSettings({configuration:selection},expected?{configuration:expected}:undefined);}
  async runConfiguration<T>(work:()=>Promise<T>,manual=true):Promise<T|undefined>{
    if(this.busy||this.unloading){
      // An automatic configuration check must not overwrite the visible status when it
      // merely overlaps a note sync; retry quietly after the other sync releases the lock.
      if(manual){this.configurationStatus='Another sync is in progress. Try again shortly';this.notifySidebar();this.feedback(this.configurationStatus,true);}
      else this.configurationRetry=Date.now()+5000;
      return;
    }
    if(!this.settings.server||!this.settings.token){this.configurationStatus='Configure the server and register this device first';this.notifySidebar();if(manual)this.feedback(this.configurationStatus,true);return;}
    this.configurationStatus='Syncing configuration…';this.setBusy(true,'Syncing configuration…');
    try{
      const result=await this.connection.run(work);
      this.configurationRetry=0;this.configurationStatus=this.configuration?.local.state.incompleteGroups?.length?'Waiting for package uploads':'Ready';return result;
    }catch(error){this.configurationStatus=error instanceof Error?error.message:String(error);this.configurationRetry=Date.now()+60000;if(manual)this.feedback(this.configurationStatus,true);}
    finally{this.setBusy(false);}
  }
  private async syncConfiguration(manual=false){
    if(!this.configuration||!this.settings.configuration.enabled||this.unloading||(!manual&&(this.settings.paused||Date.now()<this.configurationRetry)))return;
    await this.runConfiguration(()=>this.configuration!.synchronize(),manual);
  }
  private schedule(){if(this.timeout)window.clearTimeout(this.timeout);this.timeout=window.setTimeout(()=>void this.sync(),1000);}
  private report(error: unknown){this.lastError=error instanceof Error ? error.message:String(error);this.status=this.lastError;this.notifySidebar();}
  async sync(manual=false,allowMerge=false) {
    if(this.unloading || !this.engine || this.busy || !this.settings.server || !this.settings.token || (!manual && (this.settings.paused || Date.now()<this.nextRetry)))return;
    this.setBusy(true,'Syncing…');
    let previewRequired=false;
    try {await this.connection.run(()=>this.engine!.sync(allowMerge));this.status='Synced';this.lastError='';this.failures=0;this.nextRetry=0;if(manual)this.feedback('Sync completed');}
    catch(error){this.report(error);this.failures++;this.nextRetry=error instanceof SyncError && ['UNAUTHORIZED','FORBIDDEN','HTTP_401','HTTP_403'].includes(error.code) ? Infinity : Date.now()+Math.min(60000,2000*2**Math.min(this.failures,5))+Math.random()*1000;
      if(error instanceof SyncError && error.code==='INITIAL_MERGE_REQUIRED') { previewRequired=manual; }
      else if(manual)this.feedback(this.lastError,true);
    }finally{this.setBusy(false);}
    if(previewRequired)await this.preview();
    else if(manual)await this.syncConfiguration(true);
  }
  async preview(){
    if(!this.engine||this.busy)return;
    await this.openPage('Sync preview',async(box,session)=>{
      if(this.busy)return;this.setBusy(true,'Loading preview…');
      const loading=box.createEl('p',{text:'Loading preview…',attr:{role:'status'}});
      try{
        let viewed=this.connection.current;
        const items=await this.connection.run(()=>{viewed=this.connection.current;return this.engine!.preview();});
        if(!session.active())return;loading.remove();
        const list=box.createEl('ul',{cls:'mindsync-list'});
        for(const item of items)list.createEl('li',{text:`${item.action}: ${item.path}`});
        if(!items.length)list.createEl('li',{text:'No pending changes'});
        // Keep the confirm button disabled while another sync owns the lock, instead of
        // letting the click fail with an error banner.
        let confirm:ButtonComponent|undefined;
        let confirmBusy:boolean|undefined;
        // Only touch the DOM when the lock state actually changes, and keep the label
        // fixed so the button does not resize or repaint on every progress tick.
        const updateConfirm=()=>{
          if(!confirm||confirmBusy===this.busy)return;
          confirmBusy=this.busy;
          confirm.setDisabled(this.busy);
          confirm.buttonEl.title=this.busy?'A sync is already running. Wait for it to finish.':'';
        };
        new Setting(box).addButton(b=>{
          confirm=b;
          b.setButtonText('Sync this plan').setCta().onClick(async()=>{
            if(!session.active()||this.busy)return;
            const current=this.connection.current;
            if(current.server!==viewed.server||current.token!==viewed.token){this.feedback('Connection settings changed. Preview the sync plan again',true);return;}
            session.close();await this.sync(true,true);
          });
        });
        updateConfirm();
        const stopWatching=this.subscribeSidebar(()=>{
          if(!session.active()){stopWatching();return;}
          updateConfirm();
        });
      }catch(e){this.report(e);if(session.active())this.feedback(this.lastError,true);}finally{if(session.active())loading.remove();this.setBusy(false);}
    });
  }
  async testConnection(){if(this.busy)return;this.setBusy(true,'Testing connection…');try{const info=await this.connection.run(()=>this.api.info());this.feedback(`Connected. Protocol ${info.protocol}, remote revision ${info.cursor}`);}catch(e){this.report(e);this.feedback(this.lastError,true);}finally{this.setBusy(false);}}
  async registerDevice(email:string,password:string){
    if(this.busy)throw new SyncError('SYNC_BUSY','Sync is in progress. Try registering the device later');
    this.setBusy(true,'Registering device…');
    try{await this.connection.run(async()=>{
      const server=this.connection.current.server;
      const session=await this.makeApi('').login(email,password);
      const admin=this.makeApi(session.session_token);
      try{const device=await admin.register(this.settings.deviceName);await this.updateSettings({token:device.token},{server});this.feedback('Device registered');}
      finally{try{await admin.logout();}catch{this.feedback('The temporary admin session could not be closed. It will expire automatically.',true);}}
    });}finally{this.setBusy(false);}
  }
  showStatus(){void this.openPanel();}
  async history(){
    if(this.busy)return;
    const active=this.app.workspace.getActiveFile();
    const records=Object.values(this.engine?.state.files??{});
    const record=records.find(f=>f.path===active?.path&&!f.deleted);
    if(record){await this.showHistory(record);return;}
    await this.openPage('File history',async(box,session)=>{
      // Conflict copies live under their own root folder; show them as a separate section.
      const conflictRoot=/^MindSync Conflicts(?: \d+)?\//;
      const vaultFiles=records.filter(file=>!conflictRoot.test(file.path));
      const conflictFiles=records.filter(file=>conflictRoot.test(file.path));
      const treeState={collapsed:this.collapsedHistory,save:()=>this.saveHistoryState()};
      box.createEl('h3',{text:'Vault'});
      if(!vaultFiles.length&&!conflictFiles.length)box.createEl('p',{text:'No synced files have history yet'});
      else if(vaultFiles.length)renderHistoryTree(box,vaultFiles,async file=>{if(session.active())await this.showHistory(file);},'','vault',treeState);
      if(conflictFiles.length){
        box.createEl('h3',{text:'Conflicts'});
        renderHistoryTree(box,conflictFiles,async file=>{if(session.active())await this.showHistory(file);},'','conflicts',treeState,true);
      }
      if(!this.configuration||!this.settings.configuration.enabled)return;
      let files:FileRecord[]|undefined;
      try{files=await this.configuration.historyFiles();}
      catch(error){if(session.active())box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'},text:error instanceof Error?error.message:String(error)});return;}
      if(!session.active())return;
      renderConfigurationTree(box,files??[],async file=>{if(session.active())await this.showConfigurationHistory(file);},{collapsed:this.collapsedHistory,save:()=>this.saveHistoryState()});
    });
  }
  private async showConfigurationHistory(record:FileRecord){
    const configuration=this.configuration;
    if(this.busy||!configuration)return;
    await this.openPage(`History: ${record.path}`,async(box,session)=>{
      this.setBusy(true,'Loading history…');
      const loading=box.createEl('p',{text:'Loading history…',attr:{role:'status'}});
      try{
        const versions=await configuration.history(record.id);
        if(!session.active())return;loading.remove();
        box.createEl('h3',{text:record.path});
        const available=versions.versions.filter(v=>!v.deleted).sort((a,b)=>b.revision-a.revision);
        if(!available.length)box.createEl('p',{text:'No restorable revisions'});
        const latest=Math.max(...available.map(v=>v.revision));
        for(const version of available)new Setting(box).setName(`Revision ${version.revision} · ${formatBytes(version.size)}${version.revision===latest?' · Latest':''}`).addButton(b=>b.setButtonText('Restore').onClick(async()=>{
          if(!session.active())return;b.setDisabled(true);
          try{
            await configuration.restore(record.path,version);
            if(session.active()){session.close();this.feedback(`Restored revision ${version.revision} of ${record.path}. Reload Obsidian to apply it.`);}
          }catch(error){if(session.active())box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'},text:error instanceof Error?error.message:String(error)});}
          finally{b.setDisabled(false);}
        }));
      }catch(error){if(session.active())box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'},text:error instanceof Error?error.message:String(error)});}
      finally{if(session.active())loading.remove();this.setBusy(false);}
    });
  }
  private async showHistory(record:FileRecord){
    if(this.busy)return;
    await this.openPage(`History: ${record.path}`,async(box,session)=>{
      if(this.busy)return;this.setBusy(true,'Loading history…');
      const loading=box.createEl('p',{text:'Loading history…',attr:{role:'status'}});
      try{
        let viewed=this.connection.current;
        const versions=await this.connection.run(()=>{viewed=this.connection.current;return this.api.history(record.id);});
        if(!session.active())return;loading.remove();
        box.createEl('h3',{text:record.path});
        const available=versions.versions.filter(v=>!v.deleted).sort((a,b)=>b.revision-a.revision);
        if(!available.length)box.createEl('p',{text:'No restorable revisions'});
        const latest=Math.max(...available.map(v=>v.revision));
        for(const version of available){
          const setting=new Setting(box).setName(`Revision ${version.revision} · ${formatBytes(version.size)}${version.revision===latest?' · Latest':''}`);
          const preview=box.createEl('pre',{cls:'mindsync-history-preview'});preview.hidden=true;
          let loaded=false;
          setting.addButton(b=>b.setButtonText('Preview').onClick(async()=>{
            if(!session.active())return;
            if(!preview.hidden){preview.hidden=true;b.setButtonText('Preview');return;}
            if(!loaded){
              b.setDisabled(true);
              try{
                if(!/\.(md|markdown|txt|json|css|js|ts|yml|yaml|canvas)$/i.test(record.path)){preview.setText(`Binary file · ${formatBytes(version.size)}`);loaded=true;}
                else{
                  const bytes=await this.api.download(version.hash);
                  const text=new TextDecoder().decode(bytes.subarray(0,20000));
                  preview.setText(bytes.length>20000?`${text}\n… ${formatBytes(bytes.length)} total`:text);loaded=true;
                }
              }catch(error){this.feedback(error instanceof Error?error.message:String(error),true);}
              finally{b.setDisabled(false);}
            }
            if(session.active()){preview.hidden=false;b.setButtonText('Hide');}
          }));
          setting.addButton(b=>b.setButtonText('Restore').onClick(async()=>{
            if(!session.active())return;b.setDisabled(true);
            try{
              if(this.busy)throw new SyncError('SYNC_BUSY','Sync is in progress. Try restoring later');
              const current=this.connection.current;
              if(current.server!==viewed.server||current.token!==viewed.token)throw new SyncError('SETTINGS_CHANGED','Connection settings changed. Open file history again');
              this.setBusy(true,'Restoring history…');
              try{await this.connection.run(()=>this.engine!.restore(record.id,version));}finally{this.setBusy(false);}
              await this.sync(true);if(session.active()){session.close();this.feedback(`Restored revision ${version.revision} of ${record.path}`);}
            }catch(e){this.report(e);if(session.active())this.feedback(this.lastError,true);}finally{b.setDisabled(false);}
          }));
        }
        if(this.configuration&&this.settings.configuration.enabled){
          box.createEl('h3',{text:'Settings and plugins'});
          new Setting(box).addButton(b=>b.setButtonText('Browse settings history').onClick(()=>{if(session.active())void this.showConfigurationList();}));
        }
      }catch(e){this.report(e);if(session.active())this.feedback(this.lastError,true);}finally{if(session.active())loading.remove();this.setBusy(false);}
    });
  }
  private async showConfigurationList(){
    const configuration=this.configuration;
    if(this.busy||!configuration||!this.settings.configuration.enabled)return;
    await this.openPage('Settings history',async(box,session)=>{
      this.setBusy(true,'Loading history…');
      const loading=box.createEl('p',{text:'Loading history…',attr:{role:'status'}});
      try{
        const files=await configuration.historyFiles();
        if(!session.active())return;loading.remove();
        renderConfigurationTree(box,files,async file=>{if(session.active())await this.showConfigurationHistory(file);},{collapsed:this.collapsedHistory,save:()=>this.saveHistoryState()});
      }catch(error){if(session.active())box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'},text:error instanceof Error?error.message:String(error)});}
      finally{if(session.active())loading.remove();this.setBusy(false);}
    });
  }

}

class NasSettings extends PluginSettingTab {
  private unsubscribe?:()=>void;
  constructor(app:App,private plugin:MindSync){super(app,plugin);}
  hide(){this.unsubscribe?.();this.unsubscribe=undefined;super.hide();this.containerEl.removeClass('mindsync-settings');}
  display(){
    this.unsubscribe?.();
    const {containerEl:el}=this;el.empty();el.addClass('mindsync-settings');el.createEl('h2',{text:'MindSync'});
    const draft=new SettingsDraft(connectionSettings(this.plugin.settings));
    const actions:ButtonComponent[]=[],inputs:{setDisabled(value:boolean):unknown}[]=[];
    let saving=false,adminEmail='',adminPassword='',save:ButtonComponent|undefined,register:ButtonComponent|undefined;
    const error=el.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});error.hidden=true;
    const feedback=el.createEl('p',{attr:{role:'status'}});
    const updateFeedback=()=>{const result=this.plugin.sidebarSnapshot().feedback;feedback.setText(result?.text??'');feedback.hidden=!result;feedback.toggleClass('mindsync-error',result?.error??false);feedback.setAttribute('role',result?.error?'alert':'status');};
    this.unsubscribe=this.plugin.subscribeSidebar(updateFeedback);updateFeedback();
    const refresh=()=>{
      save?.setDisabled(saving||!draft.dirty);save?.setButtonText(saving?'Saving…':'Save changes');
      for(const action of actions)action.setDisabled(saving||draft.dirty);
      register?.setDisabled(saving||draft.dirty||!adminEmail||!adminPassword);
      for(const input of inputs)input.setDisabled(saving);
    };
    const report=(value:unknown)=>{error.hidden=false;error.setText(value instanceof Error?value.message:String(value));};
    new Setting(el).setName('Server URL').addText(t=>{
      inputs.push(t);t.inputEl.setAttribute('aria-label','Server URL');
      t.setValue(draft.value.server).setPlaceholder('https://notes.example.com').onChange(value=>{draft.value.server=value.trim();refresh();});
    });
    new Setting(el).setName('Device name').addText(t=>{
      inputs.push(t);t.inputEl.setAttribute('aria-label','Device name');
      t.setValue(draft.value.deviceName).onChange(value=>{draft.value.deviceName=value.trim()||'device';refresh();});
    });
    let tokenInput:HTMLInputElement;
    new Setting(el).setName('Device token').addText(t=>{
      inputs.push(t);tokenInput=t.inputEl;tokenInput.type='password';tokenInput.autocomplete='off';
      tokenInput.setAttribute('aria-label','Device token');
      t.setValue(draft.value.token).onChange(value=>{draft.value.token=value.trim();refresh();});
    }).addButton(b=>{
      b.setButtonText('Show');b.buttonEl.setAttribute('aria-label','Show device token');
      b.onClick(()=>{const visible=tokenInput.type==='password';tokenInput.type=visible?'text':'password';b.setButtonText(visible?'Hide':'Show');b.buttonEl.setAttribute('aria-label',visible?'Hide device token':'Show device token');});
    });
    new Setting(el).setName('Account email').addText(t=>{
      inputs.push(t);t.inputEl.type='email';t.inputEl.autocomplete='username';t.inputEl.setAttribute('aria-label','Account email');
      t.setPlaceholder('you@example.com').onChange(value=>{adminEmail=value.trim();refresh();});
    });
    new Setting(el).setName('Register this device').addText(t=>{
      inputs.push(t);t.inputEl.type='password';t.inputEl.autocomplete='current-password';t.inputEl.setAttribute('aria-label','Password');
      t.setPlaceholder('Password').onChange(value=>{adminPassword=value;refresh();});
    }).addButton(b=>{
      register=b;b.setButtonText('Register').onClick(async()=>{
        saving=true;refresh();try{await this.plugin.registerDevice(adminEmail,adminPassword);adminEmail='';adminPassword='';this.display();}catch(value){report(value);}finally{saving=false;refresh();}
      });
    });
    new Setting(el).setName('Connection and sync')
      .addButton(b=>{actions.push(b);b.setButtonText('Test connection').onClick(()=>void this.plugin.testConnection());})
      .addButton(b=>{actions.push(b);b.setButtonText('Preview').onClick(()=>void this.plugin.preview());})
      .addButton(b=>{actions.push(b);b.setButtonText('Sync now').setCta().onClick(()=>void this.plugin.sync(true));});
    new Setting(el).setName('Pause automatic sync').addToggle(t=>{
      inputs.push(t);t.setValue(draft.value.paused).onChange(value=>{draft.value.paused=value;refresh();});
    });
    new Setting(el).setName('Settings and plugins').addButton(b=>{
      actions.push(b);b.setButtonText('Manage').onClick(()=>showConfigurationSettings(this.plugin));
    });
    new Setting(el).addButton(b=>{
      save=b;b.setButtonText('Save changes').setCta().onClick(async()=>{
        saving=true;refresh();try{await this.plugin.updateSettings(draft.patch(),draft.expected());this.display();this.plugin.feedback('Changes saved');}
        catch(value){report(value);}finally{saving=false;refresh();}
      });
    });
    refresh();
  }
}
