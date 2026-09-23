// Standing advice for the chat's agent, kept in AGENTS.md at the vault root: the chat session's
// working folder is the vault root, so that is where the agent looks. The pane's "Append AGENTS.md
// advice" button writes the plugin's marker-delimited block there. It adds the block once and
// afterwards replaces it in place, and never changes anything outside the markers.
export const ADVICE_START = "<!-- orca-chat:advice:start -->";
export const ADVICE_END = "<!-- orca-chat:advice:end -->";
export const AGENTS_FILE = "AGENTS.md";
export const ADDED_NOTICE = "Added Orca Chat advice to AGENTS.md";
export const UPDATED_NOTICE = "Updated Orca Chat advice in AGENTS.md";

const ADVICE = [
	"## Orca Chat (Obsidian)",
	"",
	"This folder is an Obsidian vault, and you may be talking to its owner through the Orca Chat pane in Obsidian.",
	"",
	"- Be brief and conversational.",
	"- Where it helps, mention notes with inline Obsidian wikilinks — [[Note Title]] or [[Note Title|shown text]]. The chat pane makes them clickable.",
	'- Only link notes that exist in this vault: check with a file search first, and use the note\'s exact name without ".md".',
	"- Don't put wikilinks inside code spans or code blocks; they won't be clickable there.",
];

export function adviceBlock(eol: string): string {
	return [ADVICE_START, ...ADVICE, ADVICE_END].join(eol) + eol;
}

export type AdviceResult = { action: "added" | "updated"; text: string };

// The new AGENTS.md text for `existing` (null: no file yet), in the file's own line endings.
export function applyAdvice(existing: string | null): AdviceResult {
	if (existing === null) return { action: "added", text: adviceBlock("\n") };
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const start = existing.indexOf(ADVICE_START);
	if (start !== -1) {
		const end = existing.indexOf(ADVICE_END, start);
		if (end === -1) throw new Error(`AGENTS.md has the Orca Chat advice start marker but no end marker`);
		// The block without its final line ending: whatever followed the end marker stays as it was.
		const block = adviceBlock(eol).slice(0, -eol.length);
		return { action: "updated", text: existing.slice(0, start) + block + existing.slice(end + ADVICE_END.length) };
	}
	let joiner = eol + eol;
	if (existing === "" || existing.endsWith(eol + eol)) joiner = "";
	else if (existing.endsWith(eol)) joiner = eol;
	return { action: "added", text: existing + joiner + adviceBlock(eol) };
}

// The parts of Obsidian's DataAdapter this needs (paths are vault-relative).
export type AdviceAdapter = {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
};

// Writes the advice into the vault root's AGENTS.md; resolves to the Notice text.
export async function appendAgentsAdvice(adapter: AdviceAdapter): Promise<string> {
	const existing = (await adapter.exists(AGENTS_FILE)) ? await adapter.read(AGENTS_FILE) : null;
	const result = applyAdvice(existing);
	if (result.text !== existing) await adapter.write(AGENTS_FILE, result.text);
	return result.action === "added" ? ADDED_NOTICE : UPDATED_NOTICE;
}
