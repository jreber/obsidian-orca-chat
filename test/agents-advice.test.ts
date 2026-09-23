// The pane's "Append AGENTS.md advice" button: a marker-delimited block in the vault root's AGENTS.md
// (the chat session's working folder, so the agent reads it). The block is added once and afterwards
// replaced in place; nothing outside the markers is ever changed.
import test from "node:test";
import assert from "node:assert/strict";

const { applyAdvice, adviceBlock, appendAgentsAdvice, ADVICE_START, ADVICE_END, ADDED_NOTICE, UPDATED_NOTICE } = await import(
	"../src/agents-advice.ts"
);

const BLOCK = adviceBlock("\n");

test("the block is delimited by the markers and says to be brief and to link existing notes as wikilinks", () => {
	assert.ok(BLOCK.startsWith(`${ADVICE_START}\n## Orca Chat (Obsidian)\n`));
	assert.ok(BLOCK.endsWith(`\n${ADVICE_END}\n`));
	assert.match(BLOCK, /brief and conversational/);
	assert.match(BLOCK, /\[\[Note Title\]\]/);
	assert.match(BLOCK, /exist in this vault/);
	assert.ok(!/CLAUDE\.md|@AGENTS/.test(BLOCK), "no CLAUDE.md advice");
	assert.ok(!BLOCK.includes("\r"));
});

test("no AGENTS.md: it is created with just the block", () => {
	assert.deepEqual(applyAdvice(null), { action: "added", text: BLOCK });
});

test("AGENTS.md without the block: appended after one blank line, everything before untouched", () => {
	for (const [before, joiner] of [
		["# Agents\n\nBe nice.", "\n\n"],
		["# Agents\n\nBe nice.\n", "\n"],
		["# Agents\n\nBe nice.\n\n", ""],
		["", ""],
	] as const) {
		const { action, text } = applyAdvice(before);
		assert.equal(action, "added");
		assert.equal(text, before + joiner + BLOCK, JSON.stringify(before));
	}
});

test("AGENTS.md with the block: it is replaced in place with the current text, the rest untouched", () => {
	const before = "# Mine\n\nIntro.\n\n";
	const after = "\n\nAfter the block.\n";
	const existing = `${before}${ADVICE_START}\nold advice\nmore old advice\n${ADVICE_END}${after}`;
	const { action, text } = applyAdvice(existing);
	assert.equal(action, "updated");
	assert.equal(text, `${before}${BLOCK.slice(0, -1)}${after}`);
	assert.equal(text.split(ADVICE_START).length, 2, "the block appears once");
});

test("pressing it again changes nothing: the block is not duplicated", () => {
	const once = applyAdvice("Intro\n").text;
	assert.deepEqual(applyAdvice(once), { action: "updated", text: once });
	const created = applyAdvice(null).text;
	assert.deepEqual(applyAdvice(created), { action: "updated", text: created });
});

test("CRLF files keep CRLF, when appending and when replacing", () => {
	const before = "# Agents\r\n\r\nBe nice.\r\n";
	const appended = applyAdvice(before).text;
	assert.equal(appended, before + "\r\n" + adviceBlock("\r\n"));
	assert.ok(!/[^\r]\n/.test(appended), "every line ending is CRLF");
	const stale = `A\r\n${ADVICE_START}\r\nold\r\n${ADVICE_END}\r\nZ\r\n`;
	const replaced = applyAdvice(stale).text;
	assert.equal(replaced, `A\r\n${adviceBlock("\r\n")}Z\r\n`);
});

test("a start marker without an end marker is refused rather than guessed at", () => {
	assert.throws(() => applyAdvice(`x\n${ADVICE_START}\nhalf a block\n`), /end marker/);
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

test("in the vault: adds, then updates; only AGENTS.md is written", async () => {
	const { adapter, files, writes } = fakeAdapter({ "Note.md": "hello" });
	assert.equal(ADDED_NOTICE, "Added Orca Chat advice to AGENTS.md");
	assert.equal(UPDATED_NOTICE, "Updated Orca Chat advice in AGENTS.md");
	assert.equal(await appendAgentsAdvice(adapter), ADDED_NOTICE);
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.equal(await appendAgentsAdvice(adapter), UPDATED_NOTICE);
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.deepEqual(writes.map(([p]) => p), ["AGENTS.md"], "an unchanged block isn't rewritten");
	assert.deepEqual(Object.keys(files).sort(), ["AGENTS.md", "Note.md"]);
});

test("in the vault: appends to an existing AGENTS.md", async () => {
	const { adapter, files } = fakeAdapter({ "AGENTS.md": "Mine.\n" });
	assert.equal(await appendAgentsAdvice(adapter), ADDED_NOTICE);
	assert.equal(files["AGENTS.md"], "Mine.\n\n" + BLOCK);
});
