// Standing guidance for the chat's agent, kept in AGENTS.md at the vault root. The chat session's
// working folder is the vault root, so that is where the agent looks; Claude Code reads CLAUDE.md,
// which pulls AGENTS.md in with an "@AGENTS.md" line. The plugin only ever writes its own
// marker-delimited block and never changes anything outside it.
export const GUIDELINES_START = "<!-- orca-chat:guidelines:start -->";
export const GUIDELINES_END = "<!-- orca-chat:guidelines:end -->";
export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
export const CLAUDE_MD_ADVICE = 'Claude Code reads CLAUDE.md — add a line "@AGENTS.md" to it so chats pick this up.';

const GUIDELINES = [
	"## Orca Chat (Obsidian)",
	"",
	"This folder is an Obsidian vault, and you may be talking to its owner through the Orca Chat pane in Obsidian.",
	"",
	"- Be conversational and brief.",
	"- Mention notes with inline Obsidian wikilinks — [[Note Title]] or [[Note Title|shown text]] — as often as is natural. The chat pane makes them clickable.",
	'- Only link notes that exist in this vault: check with a file search first, and use the note\'s exact name without ".md".',
	"- Don't put wikilinks inside code spans or code blocks; they won't be clickable there.",
];

export function guidelinesBlock(eol: string): string {
	return [GUIDELINES_START, ...GUIDELINES, GUIDELINES_END].join(eol) + eol;
}

export type GuidelinesResult = { action: "created" | "appended" | "unchanged"; text: string };

// The new AGENTS.md text for `existing` (null: no file yet). Appends after one blank line, in the
// file's own line endings; a file that has the start marker already is left exactly as it is.
export function addGuidelines(existing: string | null): GuidelinesResult {
	if (existing === null) return { action: "created", text: guidelinesBlock("\n") };
	if (existing.includes(GUIDELINES_START)) return { action: "unchanged", text: existing };
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	let joiner = eol + eol;
	if (existing === "" || existing.endsWith(eol + eol)) joiner = "";
	else if (existing.endsWith(eol)) joiner = eol;
	return { action: "appended", text: existing + joiner + guidelinesBlock(eol) };
}

// The parts of Obsidian's DataAdapter this needs (paths are vault-relative).
export type GuidanceAdapter = {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
};

const ACTION_NOTICE: Record<GuidelinesResult["action"], string> = {
	created: "Orca Chat: created AGENTS.md with the chat guidelines.",
	appended: "Orca Chat: added the chat guidelines to AGENTS.md.",
	unchanged: "Orca Chat: the chat guidelines are already there in AGENTS.md.",
};

// Adds the block to the vault root's AGENTS.md; resolves to the Notice text. CLAUDE.md is only read.
export async function addChatGuidelinesToVault(adapter: GuidanceAdapter): Promise<string> {
	const existing = (await adapter.exists(AGENTS_FILE)) ? await adapter.read(AGENTS_FILE) : null;
	const result = addGuidelines(existing);
	if (result.action !== "unchanged") await adapter.write(AGENTS_FILE, result.text);
	const claude = (await adapter.exists(CLAUDE_FILE)) ? await adapter.read(CLAUDE_FILE) : "";
	const notice = ACTION_NOTICE[result.action];
	return claude.includes("@AGENTS.md") ? notice : `${notice} ${CLAUDE_MD_ADVICE}`;
}
