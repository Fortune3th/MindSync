import {ButtonComponent,Setting} from 'obsidian';
import type {PanelRenderer} from './panel-page';
import {ConfigurationSync} from './configuration-sync';
import {ConfigurationSelection, configurationApplyGroup as configurationGroup} from './configuration-paths';
import {decode} from './types';
import {SettingsDraft} from './settings';

export interface ConfigurationUiHost {
  openPage(title:string,render:PanelRenderer,back?:()=>void):Promise<void>;
  feedback(text:string,error?:boolean):void;
  configuration?: ConfigurationSync;
  configurationStatus: string;
  configurationSelection(): ConfigurationSelection;
  saveConfigurationSelection(selection: ConfigurationSelection, expected?: ConfigurationSelection): Promise<void>;
  runConfiguration<T>(work:()=>Promise<T>):Promise<T|undefined>;
}

export async function showConfigurationSettings(host:ConfigurationUiHost) {
  await host.openPage('Settings and plugins',async(box,session)=>{
  let generation=0;
  let draft=new SettingsDraft(host.configurationSelection());
  const render=async()=>{
    if(!session.active())return;const current=++generation;box.empty();box.addClass('mindsync-settings');
    const selection=draft.value,actions:{setDisabled(value:boolean):unknown}[]=[];
    let save:{setDisabled(value:boolean):unknown}|undefined,errorEl:HTMLElement|undefined;
    const refresh=()=>{save?.setDisabled(!draft.dirty);for(const action of actions)action.setDisabled(draft.dirty);};
    const footer=()=>{
      errorEl=box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});errorEl.hidden=true;
      const bar=box.createDiv({cls:'mindsync-settings-footer'});
      new Setting(bar).addButton(b=>{
        save=b;b.setButtonText('Save changes').setCta().onClick(async()=>{
          if(!session.active())return;box.inert=true;b.setButtonText('Saving…');b.setDisabled(true);
          try{await host.saveConfigurationSelection(draft.value,draft.original);if(!session.active())return;draft=new SettingsDraft(host.configurationSelection());box.inert=false;await render();host.feedback('Changes saved');}
          catch(value){if(session.active()&&errorEl){errorEl.hidden=false;errorEl.setText(value instanceof Error?value.message:String(value));}}
          finally{box.inert=false;refresh();b.setButtonText('Save changes');}
        });
      });
    };
    new Setting(box).setName('Sync settings and plugins').addToggle(toggle=>toggle.setValue(selection.enabled).onChange(async enabled=>{
      draft.value={...draft.value,enabled};await render();
    }));
    if(!selection.enabled){footer();refresh();return;}
    if(!host.configuration){footer();refresh();return;}
    const update=async(change:Partial<ConfigurationSelection>)=>{draft.value={...draft.value,...change};refresh();};
    box.createEl('h3',{text:'Obsidian settings'});
    new Setting(box).setName('Appearance').addToggle(t=>t.setValue(selection.settings).onChange(async value=>{await update({settings:value});}));
    new Setting(box).setName('Enabled plugins').addToggle(t=>t.setValue(selection.enabledPlugins).onChange(async value=>{await update({enabledPlugins:value});}));
    const pluginsTitle=box.createEl('h3',{text:'Community plugins'});pluginsTitle.hidden=true;
    const inventoryBox=box.createDiv();inventoryBox.createEl('p',{text:'Loading local and remote items…'});
    const paths=await host.configuration!.inventory().catch(error=>{inventoryBox.empty();inventoryBox.createEl('p',{text:error instanceof Error?error.message:String(error),attr:{role:'alert'}});return undefined;});
    if(!session.active()||current!==generation)return;
    if(!paths){footer();refresh();return;}
    inventoryBox.empty();
    const plugins=[...new Set(paths.filter(p=>p.startsWith('plugins/')).map(p=>p.split('/')[1]))];
    if(plugins.length)pluginsTitle.hidden=false;
    for(const id of plugins){
      const options=draft.value.plugins[id]??{files:false,settings:false},withSettings=paths.includes(`plugins/${id}/data.json`);
      new Setting(inventoryBox).setName(id).addToggle(t=>t.setValue(withSettings?options.files&&options.settings:options.files).onChange(async value=>{
        const s=draft.value,previous=s.plugins[id]??{files:false,settings:false};
        await update({plugins:{...s.plugins,[id]:{files:value,settings:withSettings?value:previous.settings}}});
      }));
    }
    const extrasTitle=box.createEl('h3',{text:'Themes and snippets'});extrasTitle.hidden=true;
    const extras=box.createDiv();
    let extrasShown=false;
    for(const [folder,label] of [['themes','Theme'],['snippets','Snippet']] as const){
      const names=[...new Set(paths.filter(p=>p.startsWith(folder+'/')).map(p=>p.split('/')[1]))];
      for(const name of names){
        extrasShown=true;
        new Setting(extras).setName(`${label}: ${name}`).addToggle(t=>t.setValue(draft.value[folder].includes(name)).onChange(async value=>{
          const selected=draft.value[folder];await update({[folder]:value?[...new Set([...selected,name])]:selected.filter(p=>p!==name)});
        }));
      }
    }
    extrasTitle.hidden=!extrasShown;
    box.createEl('h3',{text:'Share and restore'});
    const actionRow=box.createDiv({cls:'mindsync-settings-actions'});
    const publishButton=new ButtonComponent(actionRow).setButtonText('Publish').onClick(()=>{if(session.active())void showPublishPreview(host);});
    const reviewButton=new ButtonComponent(actionRow).setButtonText('Review').setCta().onClick(()=>{if(session.active())void showConfigurationUpdates(host);});
    actions.push(publishButton,reviewButton);
    footer();refresh();
  };
  await render();
  });
}

async function showPublishPreview(host:ConfigurationUiHost) {
  if(!host.configuration)return;
  await host.openPage('Publish selected settings',async(box,session)=>{
    const loading=box.createEl('p',{text:'Loading preview…',attr:{role:'status'}});
    const items=await host.runConfiguration(()=>host.configuration!.previewPublish());
    if(!session.active())return;loading.remove();if(!items)return;
    if(!items.length){
      const selection=host.configurationSelection();
      const chosen=selection.enabled&&(selection.settings||selection.enabledPlugins||selection.themes.length||selection.snippets.length||Object.values(selection.plugins).some(plugin=>plugin.files||plugin.settings));
      box.createEl('p',{text:chosen?'Everything is already up to date.':'Nothing is selected yet. Choose what to sync, save, then publish.'});
      return;
    }
    const list=box.createEl('ul');for(const item of items)list.createEl('li',{text:`${item.action}: ${item.path}`});
    new Setting(box).addButton(b=>b.setButtonText('Publish').setCta().onClick(async()=>{
      if(!session.active())return;b.setDisabled(true);
      try{
        const count=await host.runConfiguration(()=>host.configuration!.publish(items));
        if(count!==undefined&&session.active()){session.close();host.feedback(`Published ${count} configuration files`);}
      }finally{b.setDisabled(false);}
    }));
  },()=>showConfigurationSettings(host));
}

export async function showConfigurationUpdates(host:ConfigurationUiHost) {
  if(!host.configuration)return;
  await host.openPage('Review configuration updates',async(box,session)=>{
    const loading=box.createEl('p',{text:'Loading updates…',attr:{role:'status'}});
    const updates=await host.runConfiguration(()=>host.configuration!.review());
    if(!session.active())return;loading.remove();if(!updates)return;
    if(host.configuration!.local.state.incompleteGroups?.length)box.createEl('p',{text:'Incomplete package uploads',attr:{role:'status'}});
    if(!updates.length)box.createEl('p',{text:'No selected configuration updates are pending.'});
    const selectedGroups=new Set(updates.map(u=>configurationGroup(u.file.path)));
    for(const group of [...selectedGroups]){
      const members=updates.filter(u=>configurationGroup(u.file.path)===group);
      new Setting(box).setName(group).setDesc(members.map(u=>`${u.file.deleted?'Delete':'Update'} ${u.file.path} (revision ${u.file.revision})${u.conflict?' — local content differs':''}`).join('\n')).addToggle(t=>t.setValue(true).onChange(value=>{if(value)selectedGroups.add(group);else selectedGroups.delete(group);}));
      if(members.some(u=>u.conflict))new Setting(box).setName('Resolve this group').addButton(b=>b.setButtonText('Keep local').onClick(async()=>{
        if(!session.active())return;b.setDisabled(true);
        try{const result=await host.runConfiguration(()=>host.configuration!.keepLocal(members));if(result!==undefined&&session.active()){host.feedback('Local configuration published');await showConfigurationUpdates(host);}}finally{b.setDisabled(false);}
      })).addButton(b=>b.setButtonText('Use remote').onClick(async()=>{
        if(!session.active())return;b.setDisabled(true);
        try{const count=await host.runConfiguration(()=>host.configuration!.apply(members));if(count!==undefined&&session.active()){session.close();host.feedback('Configuration applied. Reload Obsidian.');}}finally{b.setDisabled(false);}
      }));
    }
    const conflicts=host.configuration!.local.state.conflicts;
    if(conflicts.length){
      box.createEl('h3',{text:'Preserved local copies'});
      for(const conflict of conflicts)new Setting(box).setName(conflict.path).setDesc(`Preserved before reviewing revision ${conflict.revision}`).addButton(b=>b.setButtonText('View conflict copy').onClick(async()=>{
        if(!session.active())return;
        await host.openPage(conflict.path,content=>{
          if(/\.(json|css)$/.test(conflict.path))content.createEl('pre',{text:new TextDecoder().decode(decode(conflict.content))});
          else content.createEl('p',{text:`Binary or plugin code preserved in the configuration recovery directory. SHA-256: ${conflict.hash}`});
        });
      }));
    }
    const error=box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});
    if(updates.length)new Setting(box).addButton(b=>b.setButtonText('Apply selected').setCta().onClick(async()=>{
      if(!session.active())return;
      const chosen=updates.filter(u=>selectedGroups.has(configurationGroup(u.file.path)));
      if(!chosen.length){error.setText('Select at least one update group.');return;}
      b.setDisabled(true);try{
        const count=await host.runConfiguration(()=>host.configuration!.apply(chosen));
        if(!session.active())return;
        if(count!==undefined){session.close();host.feedback(`Applied ${count} configuration files. Reload Obsidian.`);}else error.setText(host.configurationStatus);
      }finally{b.setDisabled(false);}
    }));
  },()=>showConfigurationSettings(host));
}
