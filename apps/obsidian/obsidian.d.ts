declare module "obsidian" {
  export interface App {
    vault: {
      adapter: {
        exists(path: string): Promise<boolean>;
        mkdir(path: string): Promise<void>;
        write(path: string, data: string): Promise<void>;
      };
    };
  }
  export class Plugin {
    app: App;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    addCommand(command: { id: string; name: string; callback: () => unknown }): void;
    addSettingTab(tab: PluginSettingTab): void;
    registerInterval(id: number): number;
  }
  export class Notice {
    constructor(message: string);
  }
  export class PluginSettingTab {
    constructor(app: App, plugin: Plugin);
    containerEl: HTMLElement & { empty(): void };
  }
  export class Setting {
    constructor(container: HTMLElement);
    setName(name: string): this;
    setDesc(description: string): this;
    addText(
      callback: (text: {
        inputEl: HTMLInputElement;
        setValue(value: string): typeof text;
        onChange(callback: (value: string) => unknown): typeof text;
      }) => unknown,
    ): this;
    addButton(
      callback: (button: {
        setButtonText(value: string): typeof button;
        onClick(callback: () => unknown): typeof button;
      }) => unknown,
    ): this;
  }
  export function requestUrl(request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    throw: boolean;
  }): Promise<{ status: number; json: unknown }>;
}
