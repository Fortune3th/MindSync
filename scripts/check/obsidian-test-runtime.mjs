// Runtime stand-ins for the headless Vault adapter acceptance harness only.
export class TFile { path=''; get extension(){return this.path.split('.').at(-1);} }
export class TFolder { path=''; }
