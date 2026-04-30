// Minimal mock of the Obsidian API for unit tests run under Node.
// Only members actually referenced at compile time need to exist here.

export class Plugin {
  app: App;
  manifest: any;
  private data: any = null;
  constructor(app?: App, manifest?: any) {
    this.app = app ?? new App();
    this.manifest = manifest ?? {};
  }
  async loadData(): Promise<any> { return this.data; }
  async saveData(data: any): Promise<void> { this.data = data; }
  addSettingTab(_tab: any): void {}
  addRibbonIcon(_icon: string, _title: string, _cb: (...a: any[]) => any): any { return {}; }
  addCommand(_cmd: any): void {}
  registerInterval(id: number): number { return id; }
}

export class App {
  vault: Vault = new Vault();
}

export class PluginSettingTab {
  app: App;
  containerEl: any = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
  constructor(app: App, _plugin: any) { this.app = app; }
  display(): void {}
}

export class Setting {
  constructor(_containerEl: any) {}
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  addText(_cb: (t: any) => any) { return this; }
  addToggle(_cb: (t: any) => any) { return this; }
  addDropdown(_cb: (d: any) => any) { return this; }
  addButton(_cb: (b: any) => any) { return this; }
  addTextArea(_cb: (t: any) => any) { return this; }
}

export class Notice {
  constructor(_msg: any, _timeout?: number) {}
  hide(): void {}
  noticeEl: any = { style: {}, addEventListener: () => {} };
}

export class Modal {
  app: App;
  contentEl: any = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
  constructor(app: App) { this.app = app; }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class TFile {
  path: string = "";
  stat: { mtime: number; size: number } = { mtime: 0, size: 0 };
}

export class TFolder {
  path: string = "";
}

export class Vault {
  adapter: DataAdapter = new DataAdapter();
  getFiles(): TFile[] { return []; }
  getAbstractFileByPath(_p: string): TFile | TFolder | null { return null; }
  async readBinary(_f: TFile): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
  async modifyBinary(_f: TFile, _d: ArrayBuffer): Promise<void> {}
  async createFolder(_p: string): Promise<void> {}
  async delete(_f: TFile | TFolder, _force?: boolean): Promise<void> {}
  async trash(_f: TFile | TFolder, _system?: boolean): Promise<void> {}
}

export class DataAdapter {
  async exists(_p: string): Promise<boolean> { return false; }
  async read(_p: string): Promise<string> { return ""; }
  async write(_p: string, _d: string): Promise<void> {}
  async writeBinary(_p: string, _d: ArrayBuffer): Promise<void> {}
  async remove(_p: string): Promise<void> {}
  async rename(_from: string, _to: string): Promise<void> {}
}

export interface RequestUrlResponse {
  status: number;
  json?: any;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export const requestUrl = jest.fn();
