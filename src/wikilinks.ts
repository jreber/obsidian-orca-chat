import { type App, Notice, type WorkspaceLeaf } from "obsidian";

// Wikilinks in the embedded chat. Orca's chat renderer drops link schemes it doesn't know (an
// obsidian:// href renders empty) and doesn't parse [[wikilinks]] at all, so the agent's [[Note]]
// arrives as plain text. The pane injects a script (the same executeJavaScript/console-message
// channel as the obsidian:// interceptor in chat-view.ts) that turns that text into anchors and
// reports two things back: clicks (open this link) and the link targets it saw (which of these
// exist?). The host resolves both against the vault itself.
//
// Everything the guest reports is untrusted: its content is shaped by the agent's output. A report
// can at most open a note that already exists in this vault.
export const WIKILINK_OPEN_MARKER = "orca-chat:wikilink-open:";
export const WIKILINK_CHECK_MARKER = "orca-chat:wikilink-check:";
export const MAX_LINK_LENGTH = 512;
export const MAX_CHECK_TARGETS = 200;
// A payload past this is not something the guest script sends.
const MAX_PAYLOAD_LENGTH = (MAX_LINK_LENGTH + 8) * MAX_CHECK_TARGETS * 6 + 64;

type GuestWindow = Window & typeof globalThis & Record<string, unknown>;

// Runs inside the guest page. It is injected as source text (Function#toString), so it must not
// reference anything outside its own body except browser globals.
function orcaWikilinksGuest(win: GuestWindow, openMarker: string, checkMarker: string, maxBatch: number, maxLink: number): void {
	if (win.__orcaWikilinksInstalled) return;
	win.__orcaWikilinksInstalled = true;
	const doc = win.document;
	const PATTERN = /\[\[([^\[\]|#\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]+))?\]\]/g;
	const SKIP = "pre, code, a, script, style, textarea, input, [contenteditable], .orca-wikilink";
	const DEAD_TITLE = "Note not found in this vault";
	// Nodes this script created, and for each text node it split: the text it left in that node and
	// the nodes it inserted after it (so a re-render or removal of that node can take them away).
	const ours = new WeakSet<Node>();
	const splits = new WeakMap<Node, { value: string; nodes: Node[] }>();
	const dead = new Set<string>();
	const reported = new Set<string>();
	let pending: string[] = [];

	const style = doc.createElement("style");
	style.textContent =
		"a.orca-wikilink{font:inherit;color:var(--orca-wikilink-color,#8b7cf6);text-decoration:underline;" +
		"text-underline-offset:2px;cursor:pointer}" +
		"a.orca-wikilink:hover{text-decoration-thickness:2px}" +
		"a.orca-wikilink.is-unresolved{opacity:.55;text-decoration-style:dotted;cursor:help}";
	ours.add(style);
	(doc.head || doc.documentElement).appendChild(style);

	function markDead(a: Element): void {
		a.classList.add("is-unresolved");
		a.setAttribute("title", DEAD_TITLE);
	}

	function anchor(link: string, shown: string): HTMLAnchorElement {
		const a = doc.createElement("a");
		a.className = "orca-wikilink";
		a.setAttribute("href", "#");
		a.setAttribute("data-orca-link", link);
		a.textContent = shown;
		ours.add(a);
		if (dead.has(link)) markDead(a);
		if (!reported.has(link)) {
			reported.add(link);
			pending.push(link);
		}
		return a;
	}

	function linkify(node: Node): void {
		if (ours.has(node) || splits.has(node)) return;
		const text = node.nodeValue || "";
		if (text.indexOf("[[") === -1) return;
		const parent = node.parentElement;
		if (!parent || parent.closest(SKIP)) return;
		const parts: Node[] = [];
		let last = 0;
		let lead: string | null = null;
		PATTERN.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATTERN.exec(text))) {
			const target = m[1].trim();
			const heading = m[2] ? m[2].slice(1).trim() : "";
			const alias = m[3] ? m[3].trim() : "";
			const link = heading ? target + "#" + heading : target;
			if (!target || link.length > maxLink) continue;
			const before = text.slice(last, m.index);
			if (lead === null) lead = before;
			else if (before) parts.push(doc.createTextNode(before));
			parts.push(anchor(link, alias || (heading ? target + " > " + heading : target)));
			last = m.index + m[0].length;
		}
		if (lead === null) return;
		if (last < text.length) parts.push(doc.createTextNode(text.slice(last)));
		const frag = doc.createDocumentFragment();
		for (const part of parts) {
			ours.add(part);
			frag.appendChild(part);
		}
		splits.set(node, { value: lead, nodes: parts });
		node.nodeValue = lead;
		parent.insertBefore(frag, node.nextSibling);
	}

	function unsplit(node: Node): void {
		const split = splits.get(node);
		if (!split) return;
		splits.delete(node);
		for (const part of split.nodes) if (part.parentNode) part.parentNode.removeChild(part);
	}

	function walk(root: Node): void {
		if (root.nodeType === 3) {
			linkify(root);
			return;
		}
		if (root.nodeType !== 1 || ours.has(root)) return;
		const found: Node[] = [];
		const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
		while (walker.nextNode()) found.push(walker.currentNode);
		for (const text of found) linkify(text);
	}

	function flush(): void {
		while (pending.length) {
			const batch = pending.slice(0, maxBatch);
			pending = pending.slice(maxBatch);
			win.console.log(checkMarker + JSON.stringify(batch));
		}
	}

	win.__orcaWikilinksMark = function (links: unknown): void {
		if (!Array.isArray(links)) return;
		for (const link of links) if (typeof link === "string") dead.add(link);
		const all = doc.querySelectorAll("a.orca-wikilink");
		for (let i = 0; i < all.length; i++) {
			if (dead.has(all[i].getAttribute("data-orca-link") || "")) markDead(all[i]);
		}
	};

	doc.addEventListener(
		"click",
		function (event: Event) {
			const target = event.target as Element | null;
			const a = target && target.closest ? target.closest("a.orca-wikilink") : null;
			if (!a) return;
			event.preventDefault();
			event.stopPropagation();
			win.console.log(openMarker + JSON.stringify({ link: a.getAttribute("data-orca-link") }));
		},
		true,
	);

	if (!doc.body) return;
	walk(doc.body);
	flush();
	new win.MutationObserver(function (records: MutationRecord[]) {
		for (const record of records) {
			if (record.type === "characterData") {
				const node = record.target;
				if (ours.has(node)) continue;
				const split = splits.get(node);
				// Our own truncation of the node; anything else is the page re-rendering it.
				if (split && node.nodeValue === split.value) continue;
				unsplit(node);
				linkify(node);
				continue;
			}
			for (let i = 0; i < record.removedNodes.length; i++) unsplit(record.removedNodes[i]);
			for (let i = 0; i < record.addedNodes.length; i++) {
				const added = record.addedNodes[i];
				if (!ours.has(added) && added.isConnected) walk(added);
			}
		}
		flush();
	}).observe(doc.body, { childList: true, subtree: true, characterData: true });
}

export function wikilinkGuestScript(): string {
	const args = [WIKILINK_OPEN_MARKER, WIKILINK_CHECK_MARKER, MAX_CHECK_TARGETS, MAX_LINK_LENGTH].map((a) => JSON.stringify(a));
	return `(${orcaWikilinksGuest.toString()})(window, ${args.join(", ")});`;
}

// Tells the guest which of the targets it reported don't exist in the vault. The targets are
// embedded as a JSON literal, so they can only ever be data.
export function wikilinkMarkScript(unresolved: string[]): string {
	return `window.__orcaWikilinksMark && window.__orcaWikilinksMark(${JSON.stringify(unresolved)});`;
}

function isLinkText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= MAX_LINK_LENGTH &&
		// eslint-disable-next-line no-control-regex
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function parsePayload(message: unknown, marker: string): unknown {
	if (typeof message !== "string" || !message.startsWith(marker)) return undefined;
	const body = message.slice(marker.length);
	if (body.length > MAX_PAYLOAD_LENGTH) return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

// `{ link }` from a click report, or null for anything else.
export function parseWikilinkOpen(message: unknown): string | null {
	const payload = parsePayload(message, WIKILINK_OPEN_MARKER);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const link = (payload as { link?: unknown }).link;
	return isLinkText(link) ? link : null;
}

// The valid targets of a check report (invalid entries dropped), or null for anything else.
export function parseWikilinkCheck(message: unknown): string[] | null {
	const payload = parsePayload(message, WIKILINK_CHECK_MARKER);
	if (!Array.isArray(payload) || payload.length > MAX_CHECK_TARGETS) return null;
	return payload.filter(isLinkText);
}

// The note part of a link text: "Note#Heading" → "Note".
export function linkpathOf(link: string): string {
	const hash = link.indexOf("#");
	return (hash === -1 ? link : link.slice(0, hash)).trim();
}

export function unresolvedLinks(links: string[], resolves: (linkpath: string) => boolean): string[] {
	return links.filter((link) => !resolves(linkpathOf(link)));
}

type WikilinkApp = Pick<App, "metadataCache" | "workspace">;

const isChatLeaf = (leaf: WorkspaceLeaf, chatLeaf: WorkspaceLeaf) =>
	leaf === chatLeaf || (leaf.view as { getViewType?: () => string } | null)?.getViewType?.() === "orca-chat-view";

// Opens a vault note named by a clicked wikilink in the main editor area. A click inside the chat
// made the chat's leaf active, so opening "in the current leaf" would replace the chat itself: the
// most recent main-area leaf is used instead, or a new tab. Never creates a note.
export async function openWikilink(app: WikilinkApp, chatLeaf: WorkspaceLeaf, link: string): Promise<void> {
	const linkpath = linkpathOf(link);
	if (!linkpath || !app.metadataCache.getFirstLinkpathDest(linkpath, "")) {
		new Notice(`Orca Chat: no note named "${linkpath}" in this vault`);
		return;
	}
	const workspace = app.workspace;
	const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
	if (recent && !isChatLeaf(recent, chatLeaf)) {
		workspace.setActiveLeaf(recent, { focus: true });
		await workspace.openLinkText(link, "", false);
	} else {
		await workspace.openLinkText(link, "", "tab");
	}
}

export function interceptWikilinks(
	webview: HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> },
	app: WikilinkApp,
	chatLeaf: WorkspaceLeaf,
): void {
	webview.addEventListener("dom-ready", () => {
		void webview.executeJavaScript?.(wikilinkGuestScript());
	});
	webview.addEventListener("console-message", ((event: Event) => {
		const message = (event as unknown as { message?: unknown }).message;
		const link = parseWikilinkOpen(message);
		if (link !== null) {
			openWikilink(app, chatLeaf, link).catch((err: unknown) => console.error("[orca-chat] couldn't open a wikilink", err));
			return;
		}
		const targets = parseWikilinkCheck(message);
		if (!targets || targets.length === 0) return;
		const unresolved = unresolvedLinks(targets, (linkpath) => Boolean(linkpath && app.metadataCache.getFirstLinkpathDest(linkpath, "")));
		if (unresolved.length > 0) void webview.executeJavaScript?.(wikilinkMarkScript(unresolved))?.catch(() => {});
	}) as EventListener);
}
