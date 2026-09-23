// "Add chat guidelines to AGENTS.md": a marker-delimited block in the vault root's AGENTS.md (the
// chat session's working folder, so the agent reads it). Nothing outside the markers is ever changed.
import test from "node:test";
import assert from "node:assert/strict";

const { addGuidelines, addChatGuidelinesToVault, guidelinesBlock, GUIDELINES_START, GUIDELINES_END, CLAUDE_MD_ADVICE } = await import(
	"../src/agents-guidance.ts"
);

const BLOCK = guidelinesBlock("\n");

test("the block is delimited by the markers and carries the chat guidance", () => {
	assert.ok(BLOCK.startsWith(`${GUIDELINES_START}\n## Orca Chat (Obsidian)\n`));
	assert.ok(BLOCK.endsWith(`\n${GUIDELINES_END}\n`));
	assert.match(BLOCK, /\[\[Note Title\]\]/);
	assert.match(BLOCK, /\[\[Note Title\|shown text\]\]/);
	assert.match(BLOCK, /exist in this vault/);
	assert.match(BLOCK, /code spans or code blocks/);
	assert.ok(!BLOCK.includes("\r"));
});

test("no AGENTS.md: it is created with just the block", () => {
	assert.deepEqual(addGuidelines(null), { action: "created", text: BLOCK });
});

test("AGENTS.md without the block: the block is appended after one blank line, the rest untouched", () => {
	for (const [before, joiner] of [
		["# Agents\n\nBe nice.", "\n\n"],
		["# Agents\n\nBe nice.\n", "\n"],
		["# Agents\n\nBe nice.\n\n", ""],
		["", ""],
	] as const) {
		const { action, text } = addGuidelines(before);
		assert.equal(action, "appended");
		assert.equal(text, before + joiner + BLOCK, JSON.stringify(before));
		assert.ok(text.startsWith(before));
	}
});

test("AGENTS.md that already has the block is left exactly as it is", () => {
	const existing = `# Mine\n\n${GUIDELINES_START}\nmy own edits\n${GUIDELINES_END}\n\nAfter.\n`;
	assert.deepEqual(addGuidelines(existing), { action: "unchanged", text: existing });
});

test("CRLF files keep CRLF, in the block and the separator", () => {
	const before = "# Agents\r\n\r\nBe nice.\r\n";
	const { text } = addGuidelines(before);
	assert.equal(text, before + "\r\n" + guidelinesBlock("\r\n"));
	assert.ok(!/[^\r]\n/.test(text), "every line ending is CRLF");
});

test("running it twice changes nothing the second time", () => {
	const once = addGuidelines("Intro\n").text;
	assert.deepEqual(addGuidelines(once), { action: "unchanged", text: once });
	const created = addGuidelines(null).text;
	assert.deepEqual(addGuidelines(created), { action: "unchanged", text: created });
});

function fakeAdapter(files: Record<string, string>) {
	const writes: [string, string][] = [];
	return {
		files,
		writes,
		adapter: {
			exists: async (p: string) => p in files,
			read: async (p: string) => {
				if (!(p in files)) throw new Error(`no ${p}`);
				return files[p];
			},
			write: async (p: string, data: string) => {
				writes.push([p, data]);
				files[p] = data;
			},
		},
	};
}

test("in the vault: creates, then reports it's already there without writing", async () => {
	const { adapter, files, writes } = fakeAdapter({ "CLAUDE.md": "# Claude\n@AGENTS.md\n" });
	assert.equal(await addChatGuidelinesToVault(adapter), "Orca Chat: created AGENTS.md with the chat guidelines.");
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.equal(await addChatGuidelinesToVault(adapter), "Orca Chat: the chat guidelines are already there in AGENTS.md.");
	assert.equal(writes.length, 1);
	assert.equal(files["CLAUDE.md"], "# Claude\n@AGENTS.md\n");
});

test("in the vault: appends to an existing AGENTS.md", async () => {
	const { adapter, files } = fakeAdapter({ "AGENTS.md": "Mine.\n", "CLAUDE.md": "@AGENTS.md" });
	assert.equal(await addChatGuidelinesToVault(adapter), "Orca Chat: added the chat guidelines to AGENTS.md.");
	assert.equal(files["AGENTS.md"], "Mine.\n\n" + BLOCK);
});

test("advises importing AGENTS.md from CLAUDE.md when CLAUDE.md is missing or doesn't, and never touches it", async () => {
	assert.equal(CLAUDE_MD_ADVICE, 'Claude Code reads CLAUDE.md — add a line "@AGENTS.md" to it so chats pick this up.');
	const missing = fakeAdapter({});
	assert.equal(await addChatGuidelinesToVault(missing.adapter), `Orca Chat: created AGENTS.md with the chat guidelines. ${CLAUDE_MD_ADVICE}`);
	assert.ok(!("CLAUDE.md" in missing.files));
	const without = fakeAdapter({ "CLAUDE.md": "# Claude\n" });
	assert.equal(
		await addChatGuidelinesToVault(without.adapter),
		`Orca Chat: created AGENTS.md with the chat guidelines. ${CLAUDE_MD_ADVICE}`,
	);
	assert.equal(without.files["CLAUDE.md"], "# Claude\n");
	assert.deepEqual(without.writes.map(([p]) => p), ["AGENTS.md"]);
});
