import {test,expect} from 'vitest';
import {SettingsDraft,SettingsStore,connectionSettings,Settings} from '../src/settings';
import {defaultConfigurationSelection} from '../src/configuration-paths';

const initial=():Settings=>({server:'https://a.example',token:'original-device-token',deviceName:'Original',paused:true,configuration:defaultConfigurationSelection()});
test('editing a draft leaves saved credentials and settings untouched',()=>{
  const settings=initial(),draft=new SettingsDraft(connectionSettings(settings));
  draft.value.deviceName='Updated';draft.value.paused=false;
  expect(settings).toEqual(initial());expect(draft.value.token).toBe(settings.token);
  expect(draft.patch()).toEqual({deviceName:'Updated',paused:false});
  expect(draft.expected()).toEqual({deviceName:'Original',paused:true});
});
test('successful save applies settings only after persistence completes',async()=>{
  let settings=initial(),release!:()=>void;const persisted:Settings[]=[];
  const store=new SettingsStore(()=>settings,async value=>{persisted.push(value);await new Promise<void>(resolve=>release=resolve);},value=>{settings=value;});
  const save=store.update({deviceName:'Updated'});await Promise.resolve();
  expect(settings.deviceName).toBe('Original');expect(persisted[0].token).toBe('original-device-token');release();await save;
  expect(settings.deviceName).toBe('Updated');expect(settings.token).toBe('original-device-token');
});
test('a failed save retains the original connection and subsequent saves can succeed',async()=>{
  let settings=initial(),fail=true;
  const store=new SettingsStore(()=>settings,async()=>{if(fail)throw new Error('disk full');},value=>{settings=value;});
  await expect(store.update({server:'https://b.example',token:'new-token'})).rejects.toThrow('disk full');expect(settings).toEqual(initial());
  fail=false;await store.update({deviceName:'Updated'});expect(settings.token).toBe('original-device-token');expect(settings.deviceName).toBe('Updated');
});
test('saving an unrelated draft preserves a newly registered token',async()=>{
  let settings=initial();const draft=new SettingsDraft(connectionSettings(settings));draft.value.deviceName='Updated';
  const store=new SettingsStore(()=>settings,async()=>{},value=>{settings=value;});
  await store.update({token:'registered-token'});await store.update(draft.patch(),draft.expected());
  expect(settings.token).toBe('registered-token');expect(settings.deviceName).toBe('Updated');
});
test('a stale credential edit is rejected without deleting the current token',async()=>{
  let settings=initial();const draft=new SettingsDraft(connectionSettings(settings));draft.value.token='';
  const store=new SettingsStore(()=>settings,async()=>{},value=>{settings=value;});await store.update({token:'registered-token'});
  await expect(store.update(draft.patch(),draft.expected())).rejects.toMatchObject({code:'SETTINGS_CHANGED'});expect(settings.token).toBe('registered-token');
});
test('queued updates merge against the latest settings and preserve configuration choices',async()=>{
  let settings=initial();const store=new SettingsStore(()=>settings,async()=>{},value=>{settings=value;});
  await Promise.all([store.update({configuration:{...settings.configuration,enabled:true}}),store.update({deviceName:'Updated'}),store.update(current=>({paused:!current.paused})),store.update(current=>({paused:!current.paused}))]);
  expect(settings.configuration.enabled).toBe(true);expect(settings.deviceName).toBe('Updated');expect(settings.paused).toBe(true);expect(settings.token).toBe('original-device-token');
});
test('registration cannot install credentials after the server changes',async()=>{
  let settings=initial();const store=new SettingsStore(()=>settings,async()=>{},value=>{settings=value;});
  await store.update({server:'https://b.example'});
  await expect(store.update({token:'a-server-token'},{server:'https://a.example'})).rejects.toMatchObject({code:'SETTINGS_CHANGED'});expect(settings.token).toBe('original-device-token');
});
test('configuration drafts do not change active selection until saved',async()=>{
  let settings=initial();const draft=new SettingsDraft(settings.configuration);draft.value.enabled=true;draft.value.plugins.example={files:true,settings:true};
  expect(settings.configuration.enabled).toBe(false);expect(settings.configuration.plugins).toEqual({});
  const store=new SettingsStore(()=>settings,async()=>{},value=>{settings=value;});await store.update({configuration:draft.value},{configuration:draft.original});expect(settings.configuration).toEqual(draft.value);
});
