import {addIcon} from 'obsidian';
import brainCircuit from '../assets/brain-circuit.svg';

export const MINDSYNC_ICON='mindsync-brain-circuit';
export function registerMindSyncIcon() {
  // Obsidian wraps custom icon content in a 100-by-100 SVG viewport.
  const content=brainCircuit.replace(/^\s*<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'');
  addIcon(MINDSYNC_ICON,`<g transform="scale(${100/28})" stroke="none">${content}</g>`);
}
