import {validatePath} from './types';

export interface ConfigurationSelection {
  enabled: boolean;
  settings: boolean;
  enabledPlugins: boolean;
  themes: string[];
  snippets: string[];
  plugins: Record<string, {files: boolean; settings: boolean}>;
}
export const defaultConfigurationSelection = (): ConfigurationSelection => ({enabled:false,settings:true,enabledPlugins:false,themes:[],snippets:[],plugins:{}});
const settings = new Set(['app.json','appearance.json','hotkeys.json','core-plugins.json']);
export function allowedPlugin(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id) && !['mindsync','obsidian-livesync','__proto__','constructor','prototype'].includes(id);
}
export function allowedConfigurationPath(path: string) {
  try { validatePath(path); } catch { return false; }
  const p=path.split('/');
  return settings.has(path) || path==='community-plugins.json'
    || (p.length===2 && p[0]==='snippets' && !p[1].startsWith('.') && p[1].endsWith('.css'))
    || (p.length===3 && p[0]==='themes' && !p[1].startsWith('.') && ['manifest.json','theme.css'].includes(p[2]))
    || (p.length===3 && p[0]==='plugins' && allowedPlugin(p[1]) && ['manifest.json','main.js','styles.css','data.json'].includes(p[2]));
}
export function selectedConfigurationPath(path: string, selection: ConfigurationSelection) {
  if (!selection.enabled || !allowedConfigurationPath(path)) return false;
  const p=path.split('/');
  if (settings.has(path)) return selection.settings;
  if (path==='community-plugins.json') return selection.enabledPlugins;
  if (p[0]==='themes') return selection.themes.includes(p[1]);
  if (p[0]==='snippets') return selection.snippets.includes(p[1]);
  const plugin=Object.hasOwn(selection.plugins,p[1]) ? selection.plugins[p[1]] : undefined;
  return !!plugin && (p[2]==='data.json' ? plugin.settings : plugin.files);
}
export const configurationGroup = (path: string) => path.startsWith('plugins/') && !path.endsWith('/data.json') ? path.split('/').slice(0,2).join('/') : path.startsWith('themes/') ? path.split('/').slice(0,2).join('/') : path;

export const configurationApplyGroup = (path: string) => path.startsWith('plugins/') ? path.split('/').slice(0,2).join('/') : configurationGroup(path);
