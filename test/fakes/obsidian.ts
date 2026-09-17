// Minimal runtime stand-in for the real `obsidian` package, which ships types only (main: "",
// see node_modules/obsidian/package.json) — there is nothing to import at runtime outside the
// actual app. This implements just enough of Obsidian's DOM-extension methods and view/component
// classes for src/*.ts to run under jsdom in tests. Extend it as tests need more of the surface;
// don't front-load the rest of the API.

type DomElOptions = { cls?: string | string[]; text?: string; type?: string; placeholder?: string; attr?: Record<string, string> };

function applyOptions(el: HTMLElement, opts?: DomElOptions): void {
	if (!opts) return;
	if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
	if (opts.text !== undefined) el.textContent = opts.text;
	if (opts.type) (el as HTMLInputElement).type = opts.type;
	if (opts.placeholder) (el as HTMLInputElement).placeholder = opts.placeholder;
	if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
}

// Obsidian augments HTMLElement.prototype globally with these helpers in the real app. Patching
// the prototype here (once, idempotently) is what lets plain jsdom elements returned by
// document.createElement respond to the same calls src/*.ts makes on them.
export function installDomExtensions(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (proto.__orcaChatFakeInstalled) return;
	proto.__orcaChatFakeInstalled = true;
	proto.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.addClass = function (this: HTMLElement, ...cls: string[]) {
		this.classList.add(...cls);
	};
	proto.removeClass = function (this: HTMLElement, ...cls: string[]) {
		this.classList.remove(...cls);
	};
	proto.setText = function (this: HTMLElement, text: string) {
		this.textContent = text;
	};
	proto.createEl = function (this: HTMLElement, tag: string, opts?: DomElOptions) {
		const el = document.createElement(tag);
		applyOptions(el, opts);
		this.appendChild(el);
		return el;
	};
	proto.createDiv = function (this: HTMLElement, opts?: DomElOptions) {
		return (this as unknown as { createEl: typeof proto.createEl }).createEl("div", opts);
	};
	proto.createSpan = function (this: HTMLElement, opts?: DomElOptions) {
		return (this as unknown as { createEl: typeof proto.createEl }).createEl("span", opts);
	};
}

export class Notice {
	readonly message: string;
	constructor(message: string) {
		this.message = message;
		FakeNoticeLog.push(message);
	}
}

// Tests assert on Notice text (e.g. "did an error toast fire?") without needing a spy framework.
export const FakeNoticeLog: string[] = [];

export class WorkspaceLeaf {
	view: unknown = null;
}

export class Component {
	private intervals: number[] = [];
	registerInterval(id: number): number {
		this.intervals.push(id);
		return id;
	}
	registerDomEvent(): void {}
	register(): void {}
}

export class View extends Component {
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	leaf: WorkspaceLeaf;
	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.containerEl = document.createElement("div");
		const navHeaderEl = document.createElement("div");
		this.contentEl = document.createElement("div");
		this.containerEl.appendChild(navHeaderEl);
		this.containerEl.appendChild(this.contentEl);
	}
}

export class ItemView extends View {}

export class App {
	workspace: Record<string, unknown> = {};
}

export class Plugin extends Component {
	app: App;
	private data: unknown = null;
	constructor(app: App) {
		super();
		this.app = app;
	}
	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
	addCommand(): void {}
	registerView(): void {}
}

export class DropdownComponent {
	selectEl: HTMLSelectElement;
	private changeHandler: (() => void) | null = null;
	constructor(containerEl: HTMLElement) {
		this.selectEl = document.createElement("select");
		containerEl.appendChild(this.selectEl);
		this.selectEl.addEventListener("change", () => this.changeHandler?.());
	}
	addOption(value: string, display: string): this {
		const opt = document.createElement("option");
		opt.value = value;
		opt.text = display;
		this.selectEl.appendChild(opt);
		return this;
	}
	getValue(): string {
		return this.selectEl.value;
	}
	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
	onChange(cb: () => void): this {
		this.changeHandler = cb;
		return this;
	}
}

export class Modal {
	app: App;
	contentEl: HTMLElement;
	constructor(app: App) {
		this.app = app;
		this.contentEl = document.createElement("div");
	}
	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}
