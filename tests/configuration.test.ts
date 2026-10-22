import {test,expect} from 'vitest';
import {ConfigurationLocal, parseConfigurationJson} from '../src/configuration-local';
import {ConfigurationSync} from '../src/configuration-sync';
import {allowedConfigurationPath, defaultConfigurationSelection, selectedConfigurationPath} from '../src/configuration-paths';
import {digest,encode} from '../src/types';
import {configurationDisk,configurationPair,pluginManifest} from './configuration-fixture';
import {sample,string,text} from './helpers';

test('selection excludes credentials, workspace, cache and unselected plugin settings',()=>{
  const selection=defaultConfigurationSelection();selection.enabled=true;selection.plugins.calendar={files:true,settings:false};
  for(const path of ['workspace.json','workspace-mobile.json','plugins/mindsync/data.json','plugins/obsidian-livesync/data.json','plugins/calendar/cache.json','../app.json','plugins/constructor/main.js'])expect(allowedConfigurationPath(path)).toBe(false);
  expect(selectedConfigurationPath('app.json',selection)).toBe(true);expect(selectedConfigurationPath('plugins/calendar/main.js',selection)).toBe(true);expect(selectedConfigurationPath('plugins/calendar/data.json',selection)).toBe(false);
});

test('selected configuration round trip stages changes without touching target files',async()=>{
  const {a,b,A,B,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:true};other.plugins.calendar={files:true,settings:true};selection.themes=other.themes=['Example'];selection.snippets=other.snippets=['custom.css'];
  const source={'app.json':'{"spellcheck":true}','snippets/custom.css':'body { color: red; }','themes/Example/theme.css':'body {}','themes/Example/manifest.json':'{"name":"Example"}','plugins/calendar/manifest.json':pluginManifest('calendar'),'plugins/calendar/main.js':'module.exports = class Calendar {};','plugins/calendar/data.json':'{"format":"short"}'};
  for(const [path,content] of Object.entries(source))a.set('.obsidian/'+path,content);
  a.set('.obsidian/plugins/mindsync/data.json','{"token":"private"}');a.set('.obsidian/workspace.json','{"device":"private"}');
  await A.publish(await A.previewPublish());const updates=await B.review();expect(updates).toHaveLength(Object.keys(source).length);expect(b.files.has('custom-config/app.json')).toBe(false);
  await B.apply(updates);for(const [path,content] of Object.entries(source))expect(string(b.files.get('custom-config/'+path)!)).toBe(content);
  expect(b.files.has('custom-config/plugins/mindsync/data.json')).toBe(false);expect(b.files.has('custom-config/workspace.json')).toBe(false);
});

test('local changes after preview are preserved and application is rejected',async()=>{
  const {a,b,A,B}=configurationPair();a.set('.obsidian/app.json','{"value":"remote"}');b.set('custom-config/app.json','{"value":"local"}');await A.publish(await A.previewPublish());const updates=await B.review();b.set('custom-config/app.json','{"value":"edited"}');
  await expect(B.apply(updates)).rejects.toMatchObject({code:'LOCAL_CHANGED'});expect(string(b.files.get('custom-config/app.json')!)).toContain('edited');expect(b.local.state.conflicts).toHaveLength(1);
});

test('remote edits after preview reject a stale application',async()=>{
  const {a,b,A,B}=configurationPair();a.set('.obsidian/app.json','{"value":1}');await A.publish(await A.previewPublish());const updates=await B.review();a.set('.obsidian/app.json','{"value":2}');await A.publish(await A.previewPublish());await expect(B.apply(updates)).rejects.toMatchObject({code:'REMOTE_CHANGED'});expect(b.files.has('custom-config/app.json')).toBe(false);
});

test('selection changes never delete local files or apply deselected updates',async()=>{
  const {a,b,A,B,other}=configurationPair();a.set('.obsidian/app.json','{}');b.set('custom-config/app.json','{"local":true}');await A.publish(await A.previewPublish());const updates=await B.review();other.settings=false;
  expect(await B.review()).toEqual([]);await B.apply(updates);expect(string(b.files.get('custom-config/app.json')!)).toBe('{"local":true}');
});

test('group replacement failure restores every already written plugin file',async()=>{
  const {a,b,A,B,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));a.set('.obsidian/plugins/calendar/main.js','new code');b.set('custom-config/plugins/calendar/manifest.json',pluginManifest('calendar'));b.set('custom-config/plugins/calendar/main.js','old code');
  await A.publish(await A.previewPublish());await B.review();let failed=false;a.set('.obsidian/plugins/calendar/styles.css','new style');b.set('custom-config/plugins/calendar/styles.css','old style');
  await A.publish(await A.previewPublish());const complete=await B.review();
  b.failRename(path=>{if(!failed&&path.endsWith('/styles.css')){failed=true;return true;}return false;});
  await expect(B.apply(complete)).rejects.toThrow('rename interrupted');expect(string(b.files.get('custom-config/plugins/calendar/main.js')!)).toBe('old code');expect(b.local.state.intent).toBeUndefined();expect(b.local.state.updates['plugins/calendar/main.js']).toBeDefined();
});

test('a persisted interrupted group is rolled back on journal restart',async()=>{
  const disk=configurationDisk();disk.set('.obsidian/plugins/calendar/main.js','new code');disk.local.state.intent={id:'interrupted',items:[{path:'plugins/calendar/main.js',before:encode(text('old code')),after:encode(text('new code'))}]};await disk.local.save();
  const restarted=new ConfigurationLocal(disk.adapter,disk.configDir,disk.local.directory);await restarted.load();expect(string(await restarted.read('plugins/calendar/main.js'))).toBe('old code');expect(restarted.state.intent).toBeUndefined();
});

test('conditional JSON processing preserves a concurrent editor write',async()=>{
  const disk=configurationDisk();disk.set('.obsidian/app.json','{"value":"before"}');disk.race(path=>disk.set(path,'{"value":"editor"}'));
  await expect(disk.local.apply([{path:'app.json',bytes:text('{"value":"remote"}'),expectedHash:await digest(text('{"value":"before"}'))}])).rejects.toMatchObject({code:'LOCAL_CHANGED'});
  expect(string(await disk.local.read('app.json'))).toContain('editor');expect([...disk.files.keys()].some(p=>p.includes('/backups/'))).toBe(true);
});

test('desktop-only plugin cannot be applied on a mobile device',async()=>{
  const {a,b,A,remote,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar',true));a.set('.obsidian/plugins/calendar/main.js','code');await A.publish(await A.previewPublish());
  const mobile=new ConfigurationSync(b.local,remote,()=>other,true);const updates=await mobile.review();await expect(mobile.apply(updates)).rejects.toMatchObject({code:'INCOMPATIBLE_PLUGIN'});expect(b.files.has('custom-config/plugins/calendar/main.js')).toBe(false);
});

test('plugin manifest identity is verified before any group is written',async()=>{
  const {a,b,A,B,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('other'));a.set('.obsidian/plugins/calendar/main.js','code');await A.publish(await A.previewPublish());const updates=await B.review();await expect(B.apply(updates)).rejects.toMatchObject({code:'INVALID_PLUGIN'});expect(b.files.has('custom-config/app.json')).toBe(false);
});

test('committed response loss resumes from the ledger without reuploading chunks',async()=>{
  const {a,A,remote,selection}=configurationPair();a.set('.obsidian/app.json','{}');remote.loseReply=true;await expect(A.publish(await A.previewPublish())).rejects.toThrow('response lost');const uploads=remote.uploads;
  const local=new ConfigurationLocal(a.adapter,a.configDir,a.local.directory);await local.load();const resumed=new ConfigurationSync(local,remote,()=>selection);await resumed.review();expect(remote.uploads).toBe(uploads);expect(remote.log).toHaveLength(1);expect(local.state.pending).toHaveLength(0);
});

test('large plugin candidates survive interruption and reuse present chunks',async()=>{
  const {a,A,remote,selection}=configurationPair();selection.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));a.set('.obsidian/plugins/calendar/main.js',sample(600000));remote.failAfter=3;
  await expect(A.publish(await A.previewPublish())).rejects.toThrow('network interrupted');const previous=new Set(remote.objects.keys());expect(a.local.state.pending.length).toBeGreaterThan(0);
  const local=new ConfigurationLocal(a.adapter,a.configDir,a.local.directory);await local.load();remote.failAfter=undefined;const resumed=new ConfigurationSync(local,remote,()=>selection);await resumed.review();expect(local.state.pending).toHaveLength(0);expect([...previous].every(h=>remote.objects.has(h))).toBe(true);
});

test('differing first-publish content becomes a reviewable conflict, then keep-local creates a new revision',async()=>{
  const {a,b,A,B}=configurationPair();a.set('.obsidian/app.json','{"source":1}');b.set('custom-config/app.json','{"source":2}');await A.publish(await A.previewPublish());expect(await B.publish(await B.previewPublish())).toBe(0);const updates=B.updates();expect(updates[0].conflict).toBe(true);await B.keepLocal(updates);expect(B.updates()).toEqual([]);const incoming=await A.review();await A.apply(incoming);expect(string(await a.local.read('app.json'))).toContain('2');
});

test('enabled plugin lists exclude private IDs and preserve unrelated target choices',async()=>{
  const {a,b,A,B,selection,other}=configurationPair();selection.enabledPlugins=other.enabledPlugins=true;selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/community-plugins.json','["mindsync","obsidian-livesync","calendar","unselected"]');b.set('custom-config/community-plugins.json','["mindsync","local-only"]');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));a.set('.obsidian/plugins/calendar/main.js','code');await A.publish(await A.previewPublish());const updates=await B.review();await B.apply(updates);
  expect(parseConfigurationJson((await b.local.read('community-plugins.json'))!)).toEqual(['mindsync','local-only','calendar']);
  const remoteList=Object.values(B.local.state.bases).find(b=>b.file.path==='community-plugins.json')!;expect(remoteList.file.hash).not.toBe(await b.local.hash('community-plugins.json'));expect(await B.review()).toEqual([]);
});

test('corrupted remote chunks never become a pending configuration update',async()=>{
  const {a,A,B,remote,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/main.js',sample(200000));await A.publish(await A.previewPublish());remote.corrupt=true;await expect(B.review()).rejects.toMatchObject({code:'HASH_MISMATCH'});expect(B.updates()).toHaveLength(0);
});

test('feature-disabled and incompatible-server paths issue no configuration writes',async()=>{
  const {A,selection,remote}=configurationPair();selection.enabled=false;await expect(A.previewPublish()).rejects.toMatchObject({code:'CONFIGURATION_DISABLED'});selection.enabled=true;remote.capability=false;await expect(A.review()).rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});expect(remote.log).toHaveLength(0);
});

test('configuration state slots do not touch the note journal and fall back after corruption',async()=>{
  const disk=configurationDisk();disk.set('.obsidian/plugins/mindsync/state-0.json','note journal');disk.local.state.cursor=1;await disk.local.save();disk.local.state.cursor=2;await disk.local.save();disk.set(disk.local.directory+'/state-0.json','broken');
  const restarted=new ConfigurationLocal(disk.adapter,disk.configDir,disk.local.directory);expect((await restarted.load()).cursor).toBe(1);expect(string(disk.files.get('.obsidian/plugins/mindsync/state-0.json')!)).toBe('note journal');
});

test('disabling during a chunk transfer waits for workers and preserves the candidate',async()=>{
  const {a,A,remote,selection}=configurationPair();selection.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/main.js',sample(400000));remote.onUpload=()=>{selection.enabled=false;};await expect(A.publish(await A.previewPublish())).rejects.toMatchObject({code:'CONFIGURATION_DISABLED'});expect(a.local.state.pending).toHaveLength(1);expect(remote.log).toHaveLength(0);
});

test('a changed group cannot apply files that were absent from the approved preview',async()=>{
  const {a,A,B,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};a.set('.obsidian/plugins/calendar/main.js','code');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));await A.publish(await A.previewPublish());const updates=await B.review();await expect(B.apply([updates[0]])).rejects.toMatchObject({code:'REMOTE_CHANGED'});
});
test('partial package publication remains hidden until all members have matching group markers',async()=>{
  const {a,A,B,remote,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/plugins/calendar/main.js','code');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));
  const apply=remote.apply.bind(remote);let count=0;
  remote.apply=async op=>{if(count++===1)throw new Error('interrupted package');return apply(op);};
  await expect(A.publish(await A.previewPublish())).rejects.toThrow('interrupted package');expect(await B.review()).toEqual([]);expect(B.local.state.incompleteGroups).toEqual(['plugins/calendar']);
  remote.apply=apply;await A.review();const updates=await B.review();expect(updates).toHaveLength(2);await B.apply(updates);expect(string(await B.local.read('plugins/calendar/main.js'))).toBe('code');
});
test('a package conflict is staged before any member is published and keep-local publishes a complete group',async()=>{
  const {a,b,A,B,remote,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  for(const disk of [a,b]){const prefix=disk.configDir+'/plugins/calendar/';disk.set(prefix+'main.js','code');disk.set(prefix+'manifest.json',pluginManifest('calendar'));}
  await A.publish(await A.previewPublish());b.set('custom-config/plugins/calendar/main.js','different code');const before=remote.log.length;
  expect(await B.publish(await B.previewPublish())).toBe(0);expect(remote.log.length).toBe(before);
  await B.keepLocal(B.updates());const updates=await A.review();expect(updates.length).toBeGreaterThan(0);await A.apply(updates);expect(string(await a.local.read('plugins/calendar/main.js'))).toBe('different code');
});
test('background publication retags unchanged package members and retains optional remote files',async()=>{
  const {a,A,B,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/plugins/calendar/main.js','code');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));a.set('.obsidian/plugins/calendar/styles.css','style');await A.publish(await A.previewPublish());await B.apply(await B.review());
  a.files.delete('.obsidian/plugins/calendar/styles.css');a.set('.obsidian/plugins/calendar/main.js','new code');await A.synchronize();const updates=await B.review();await B.apply(updates);expect(string(await B.local.read('plugins/calendar/main.js'))).toBe('new code');expect(string(await B.local.read('plugins/calendar/styles.css'))).toBe('style');
});
test('invalid Obsidian preference shapes are rejected without publishing',async()=>{
  const {a,A,remote}=configurationPair();a.set('.obsidian/app.json','null');await expect(A.previewPublish()).rejects.toMatchObject({code:'INVALID_CONFIGURATION'});expect(remote.log).toHaveLength(0);
});

test('selection inventory is read-only before the feature is saved as enabled',async()=>{
  const {a,A,selection,remote}=configurationPair();
  a.set('.obsidian/app.json','{}');remote.failAfter=0;
  await expect(A.publish(await A.previewPublish())).rejects.toThrow('network interrupted');
  remote.failAfter=undefined;selection.enabled=false;
  a.set('.obsidian/plugins/calendar/main.js','code');
  const before=structuredClone(a.local.state);
  expect(before.pending).toHaveLength(1);
  expect(await A.inventory()).toContain('plugins/calendar/main.js');
  expect(a.local.state).toEqual(before);expect(remote.log).toHaveLength(0);expect(remote.uploads).toBe(0);
  await expect(A.previewPublish()).rejects.toMatchObject({code:'CONFIGURATION_DISABLED'});
});

test('all immutable package candidates are journaled together before the first commit',async()=>{
  const {a,A,remote,selection}=configurationPair();selection.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/plugins/calendar/main.js','code');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));
  const save=a.local.save.bind(a.local);a.local.save=async()=>{
    if(remote.log.length===0&&a.local.state.pending.length)expect(a.local.state.pending).toHaveLength(2);
    await save();
  };
  await A.publish(await A.previewPublish());expect(remote.log).toHaveLength(2);
});

test('an approved old package cannot apply while a newer package is only partially committed',async()=>{
  const {a,A,B,remote,selection,other}=configurationPair();selection.plugins.calendar={files:true,settings:false};other.plugins.calendar={files:true,settings:false};
  a.set('.obsidian/plugins/calendar/main.js','code');a.set('.obsidian/plugins/calendar/manifest.json',pluginManifest('calendar'));await A.publish(await A.previewPublish());const old=await B.review();
  a.set('.obsidian/plugins/calendar/main.js','new code');const apply=remote.apply.bind(remote);let count=0;
  remote.apply=async op=>{if(count++===1)throw new Error('interrupted package');return apply(op);};
  await expect(A.publish(await A.previewPublish())).rejects.toThrow('interrupted package');
  await expect(B.apply(old)).rejects.toMatchObject({code:'REMOTE_CHANGED'});expect(await B.local.read('plugins/calendar/main.js')).toBeNull();
});
