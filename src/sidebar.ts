import {ButtonComponent,ItemView,type Workspace,type WorkspaceLeaf} from 'obsidian';
import {sidebarPresentation,type SidebarAction,type SidebarSnapshot} from './sidebar-state';import type {PanelRenderer} from './panel-page';
import {MINDSYNC_ICON} from './icon';

export const MINDSYNC_VIEW='mindsync-sidebar';
export interface SidebarHost {
  sidebarSnapshot():SidebarSnapshot;
  subscribeSidebar(listener:()=>void):()=>void;
  sync(manual:boolean):Promise<void>;
  preview():Promise<void>;
  history():Promise<void>;
  togglePause():Promise<void>;
  manageConfiguration():void;
  reviewConfiguration():Promise<void>;
  deleteConflict(path:string):Promise<void>;
  feedback(text:string,error?:boolean):void;
}

const text=(el:HTMLElement)=>el.textContent??'';

const opening=new WeakMap<Workspace,Promise<WorkspaceLeaf|undefined>>();
async function sidebarLeaf(workspace:Workspace) {
  // getRightLeaf(false) creates a new tab in the existing sidebar tab group.
  let leaf=workspace.getLeavesOfType(MINDSYNC_VIEW)[0];
  if(!leaf) {
    const created=workspace.getRightLeaf(false);
    if(!created)return;leaf=created;
    await leaf.setViewState({type:MINDSYNC_VIEW,active:false});
  }
  return leaf;
}
export async function openSidebar(workspace:Workspace,reveal=true) {
  let pending=opening.get(workspace);
  if(!pending){pending=sidebarLeaf(workspace);opening.set(workspace,pending);}
  try{const leaf=await pending;if(reveal&&leaf)await workspace.revealLeaf(leaf);return leaf;}
  finally{if(opening.get(workspace)===pending)opening.delete(workspace);}
}

export class MindSyncView extends ItemView {
  private unsubscribe?:()=>void;
  private active=false;
  private buttons=new Map<SidebarAction,ButtonComponent>();
  private statusEl!:HTMLElement;
  private errorEl!:HTMLElement;
  private feedbackEl!:HTMLElement;
  private values=new Map<string,HTMLElement>();
  private conflictsEl!:HTMLElement;
  private conflictsKey='';
  private variant='';
  private pauseLabel?:string;
  private disabledStates=new Map<SidebarAction,boolean>();
  private valueText=new Map<string,string>();
  private overviewEl!:HTMLElement;
  private pageEl!:HTMLElement;
  private generation=0;
  private pageAction?:SidebarAction;
  private pageBack?:()=>void;
  private backButton!:ButtonComponent;
  private currentStates=new Map<SidebarAction,boolean>();
  constructor(leaf:WorkspaceLeaf,private host:SidebarHost){super(leaf);}
  getViewType(){return MINDSYNC_VIEW;}
  getDisplayText(){return 'MindSync';}
  getIcon(){return MINDSYNC_ICON;}
  async onOpen() {
    this.unsubscribe?.();this.active=true;this.generation++;this.buttons.clear();this.values.clear();this.conflictsKey='';
    this.variant='';this.pauseLabel=undefined;this.disabledStates.clear();this.valueText.clear();this.pageAction=undefined;this.pageBack=undefined;this.currentStates.clear();
    const box=this.contentEl;box.empty();box.addClass('mindsync-sidebar');
    const toolbar=box.createDiv({cls:'mindsync-sidebar-toolbar',attr:{role:'toolbar','aria-label':'MindSync actions'}});
    const action=(key:SidebarAction,icon:string,label:string,run:()=>unknown)=>{
      const button=new ButtonComponent(toolbar).setIcon(icon).setTooltip(label).setClass('clickable-icon');
      button.buttonEl.setAttribute('aria-label',label);
      button.onClick(async()=>{
        if(!this.active)return;
        if(this.pageAction===key){this.showOverview();return;}
        if(!sidebarPresentation(this.host.sidebarSnapshot())[key])return;
        try{await run();}catch(error){if(this.active)this.host.feedback(error instanceof Error?error.message:String(error),true);}
      });this.buttons.set(key,button);
    };
    action('sync','refresh-cw','Sync now',()=>this.host.sync(true));
    action('preview','list-checks','Preview sync',()=>this.host.preview());
    action('pause','pause','Pause automatic sync',()=>this.host.togglePause());
    action('history','history','File history',()=>this.host.history());
    action('configuration','settings','Settings and plugins',()=>this.host.manageConfiguration());
    const statusRow=box.createDiv({cls:'mindsync-sidebar-status-row'});
    this.backButton=new ButtonComponent(statusRow).setIcon('arrow-left').setTooltip('Back').setClass('mindsync-back');
    this.backButton.buttonEl.setAttribute('aria-label','Back');
    this.backButton.buttonEl.hidden=true;
    this.backButton.onClick(async()=>{if(!this.active)return;if(this.pageBack)this.pageBack();else this.showOverview();});
    this.statusEl=statusRow.createEl('p',{cls:'mindsync-sidebar-status',attr:{role:'status'}});
    this.feedbackEl=statusRow.createEl('p',{cls:'mindsync-sidebar-feedback',attr:{role:'status'}});
    this.errorEl=box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});
    this.overviewEl=box.createDiv();this.pageEl=box.createDiv({cls:'mindsync-sidebar-page'});this.pageEl.hidden=true;
    const summary=this.overviewEl.createEl('dl',{cls:'mindsync-sidebar-summary'});
    for(const [key,label] of [['lastSuccess','Latest'],['pending','Pending'],['configuration','Configs'],['updates','Awaiting']]) {
      summary.createEl('dt',{text:label});this.values.set(key,summary.createEl('dd'));
    }
    const review=new ButtonComponent(this.overviewEl).setButtonText('Review updates').setClass('mindsync-review-btn').onClick(async()=>{
      if(!this.active||!sidebarPresentation(this.host.sidebarSnapshot()).review)return;
      try{await this.host.reviewConfiguration();}catch(error){if(this.active)this.host.feedback(error instanceof Error?error.message:String(error),true);}
    });this.buttons.set('review',review);
    this.overviewEl.createEl('h3',{text:'Conflicts',cls:'mindsync-sidebar-section-title'});this.conflictsEl=this.overviewEl.createDiv({cls:'mindsync-sidebar-conflicts'});
    this.unsubscribe=this.host.subscribeSidebar(()=>this.refresh());
    this.register(()=>this.disconnect());this.refresh();
  }
  async showPage(render:PanelRenderer,action?:SidebarAction,back?:()=>void) {
    if(!this.active||!this.host.sidebarSnapshot().available)return;
    const current=++this.generation;
    this.pageAction=action;
    this.pageBack=back;
    this.backButton.buttonEl.hidden=false;
    this.overviewEl.hidden=true;this.pageEl.hidden=false;this.pageEl.empty();
    this.refresh();
    const content=this.pageEl.createDiv();
    const session={active:()=>this.active&&this.generation===current&&this.host.sidebarSnapshot().available,
      close:()=>{if(session.active())this.showOverview();}};
    try{await render(content,session);}catch(error){if(session.active())this.host.feedback(error instanceof Error?error.message:String(error),true);}
  }
  showOverview(){if(!this.active)return;this.generation++;this.pageAction=undefined;this.pageBack=undefined;this.backButton.buttonEl.hidden=true;this.pageEl.empty();this.pageEl.hidden=true;this.overviewEl.hidden=false;this.refresh();}
  private refresh() {
    if(!this.active)return;
    const state=this.host.sidebarSnapshot(),view=sidebarPresentation(state);
    if(text(this.statusEl)!==view.status)this.statusEl.setText(view.status);
    const statusText=view.status.toLowerCase();
    let variant='info';
    if(statusText==='synced'||statusText==='ready')variant='success';
    else if(statusText==='paused')variant='warning';
    else if(statusText.includes('failed')||statusText.includes('unavailable')||statusText.includes('not configured'))variant='error';
    else if(state.busy&&state.activityVisible)variant='busy';
    if(this.variant!==variant){this.variant=variant;this.statusEl.setAttribute('data-variant',variant);}
    const error=state.feedback?.error?state.feedback.text:view.error,message=state.feedback&&!state.feedback.error?state.feedback.text:'';
    if(text(this.errorEl)!==error)this.errorEl.setText(error);
    if(this.errorEl.hidden!==!error)this.errorEl.hidden=!error;
    if(text(this.feedbackEl)!==message)this.feedbackEl.setText(message);
    if(this.feedbackEl.hidden!==!message)this.feedbackEl.hidden=!message;
    for(const [key,button] of this.buttons){
      const disabled=!view[key];if(this.disabledStates.get(key)!==disabled){this.disabledStates.set(key,disabled);button.setDisabled(disabled);}
      const current=this.pageAction===key;
      if(this.currentStates.get(key)!==current){this.currentStates.set(key,current);button.buttonEl.setAttribute('aria-current',current?'page':'false');}
    }
    const pause=this.buttons.get('pause')!,label=state.paused?'Resume automatic sync':'Pause automatic sync';
    if(this.pauseLabel!==label){
      this.pauseLabel=label;pause.setIcon(state.paused?'play':'pause').setTooltip(label);
      pause.buttonEl.setAttribute('aria-label',label);pause.buttonEl.setAttribute('aria-pressed',String(state.paused));
    }
    const configurationLabel=state.configurationStatus==='Ready'?'On':state.configurationStatus==='Disabled'?'Off':state.configurationStatus;
    const summary=[['lastSuccess',state.lastSuccess?new Date(state.lastSuccess).toLocaleString('en-US'):'Never'],
      ['pending',String(state.pending)],['configuration',configurationLabel],['updates',String(state.updates)]] as const;
    for(const [key,value] of summary){if(this.valueText.get(key)!==value){this.valueText.set(key,value);this.values.get(key)!.setText(value);}}
    this.buttons.get('review')!.buttonEl.hidden=state.updates===0;
    const key=JSON.stringify(state.conflicts);
    if(key===this.conflictsKey)return;this.conflictsKey=key;this.conflictsEl.empty();
    if(!state.conflicts.length){this.conflictsEl.createEl('p',{text:'No conflicts'});return;}
    for(const conflict of state.conflicts) {
      const row=this.conflictsEl.createDiv({cls:'mindsync-sidebar-conflict'});
      const title=row.createEl('p',{text:conflict.source??conflict.path,cls:'mindsync-sidebar-conflict-title'});
      const detail=[conflict.device,conflict.time?new Date(conflict.time).toLocaleString('en-US'):''].filter(Boolean).join(' · ');
      if(detail)title.setAttribute('title',detail);
      const actions=row.createDiv({cls:'mindsync-sidebar-conflict-actions'});
      if(conflict.source)new ButtonComponent(actions).setButtonText('Compare').setTooltip('Open the original and the conflict copy').onClick(async()=>{
        await this.openConflict(conflict.source!,true);await this.openConflict(conflict.path,true);
      });
      new ButtonComponent(actions).setButtonText('Open copy').setTooltip('Open the conflict copy').onClick(()=>this.openConflict(conflict.path));
      new ButtonComponent(actions).setButtonText('Delete').setTooltip('Delete the conflict copy').onClick(async()=>{
        if(!this.active)return;
        try{await this.host.deleteConflict(conflict.path);}
        catch(error){if(this.active)this.host.feedback(error instanceof Error?error.message:String(error),true);}
      });
    }
  }
  private async openConflict(path:string,newLeaf=false) {
    if(!this.active)return;
    try{await this.app.workspace.openLinkText(path,'',newLeaf);}
    catch(error){if(this.active)this.host.feedback(error instanceof Error?error.message:String(error),true);}
  }
  private disconnect(){this.active=false;this.generation++;this.unsubscribe?.();this.unsubscribe=undefined;}
  async onClose(){this.disconnect();this.contentEl.empty();}
}
