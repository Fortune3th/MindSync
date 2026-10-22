export interface PanelSession {
  active():boolean;
  close():void;
}
export type PanelRenderer=(box:HTMLElement,session:PanelSession)=>void|Promise<void>;
