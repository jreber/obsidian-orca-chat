// Standing advice for the chat's agent, kept in AGENTS.md at the vault root: the chat session's
// working folder is the vault root, so that is where Claude Code looks for it (unless the vault has
// a CLAUDE.md; see CLAUDE_MD_NOTE). The pane's "Append AGENTS.md
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

// Current Claude Code reads AGENTS.md only in a project with no CLAUDE.md of its own (its
// `instructionFiles` default), so a vault that has one may never show the agent this advice.
export const CLAUDE_MD_FILES = ["CLAUDE.md", ".claude/CLAUDE.md"];
export const CLAUDE_MD_NOTE = "This vault has a CLAUDE.md, and current Claude Code may read that instead of AGENTS.md.";

// The parts of Obsidian's Vault this needs (paths are vault-relative). The write goes through
// Vault#process, so it is atomic with an open editor's pending save; `adapter.exists` sees files the
// vault doesn't index (.claude/).
export type AdviceVault<F extends { path: string }> = {
	getFileByPath(path: string): F | null;
	getFiles(): F[];
	read(file: F): Promise<string>;
	process(file: F, fn: (data: string) => string): Promise<string>;
	create(path: string, data: string): Promise<unknown>;
	adapter: { exists(path: string): Promise<boolean> };
};

// On a case-insensitive filesystem (macOS and Windows by default) a root `agents.md` is AGENTS.md, but
// the vault indexes it under its own spelling, so creating AGENTS.md would fail with "already exists".
// The filesystem decides: the adapter's (case-insensitive there) exists says whether such a file is
// AGENTS.md. On a case-sensitive one, `agents.md` is a different file and AGENTS.md is created.
async function differentlyCasedAgentsFile<F extends { path: string }>(vault: AdviceVault<F>): Promise<F | null> {
	if (!(await vault.adapter.exists(AGENTS_FILE))) return null;
	const name = AGENTS_FILE.toLowerCase();
	return vault.getFiles().find((f) => f.path.toLowerCase() === name) ?? null;
}

// Writes the advice into the vault root's AGENTS.md; resolves to the Notice text.
export async function appendAgentsAdvice<F extends { path: string }>(vault: AdviceVault<F>): Promise<string> {
	const file = vault.getFileByPath(AGENTS_FILE) ?? (await differentlyCasedAgentsFile(vault));
	let action: AdviceResult["action"];
	if (!file) {
		const result = applyAdvice(null);
		await vault.create(AGENTS_FILE, result.text);
		action = result.action;
	} else {
		const current = await vault.read(file);
		const result = applyAdvice(current);
		action = result.action;
		// Unchanged text isn't written. Otherwise re-applied to whatever process reads, so an edit
		// since the read above is kept.
		if (result.text !== current) {
			await vault.process(file, (data) => {
				const result = applyAdvice(data);
				action = result.action;
				return result.text;
			});
		}
	}
	const notice = action === "added" ? ADDED_NOTICE : UPDATED_NOTICE;
	for (const path of CLAUDE_MD_FILES) {
		if (await vault.adapter.exists(path)) return `${notice}. ${CLAUDE_MD_NOTE}`;
	}
	return notice;
}
