// The pane's "Append AGENTS.md advice" button: a marker-delimited block in the vault root's AGENTS.md
// (the chat session's working folder, so the agent reads it). The block is added once and afterwards
// replaced in place; nothing outside the markers is ever changed.
import test from "node:test";
import assert from "node:assert/strict";

const { applyAdvice, adviceBlock, appendAgentsAdvice, ADVICE_START, ADVICE_END, ADDED_NOTICE, UPDATED_NOTICE, CLAUDE_MD_NOTE } = await import(
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

// Obsidian's Vault as appendAgentsAdvice uses it: indexed files by path, process/create, and the
// adapter's exists for unindexed paths such as .claude/.
function fakeVault(files: Record<string, string>) {
	const writes: [string, string][] = [];
	const file = (path: string) => ({ path });
	return {
		files,
		writes,
		vault: {
			getFileByPath: (p: string) => (p in files && !p.startsWith(".") ? file(p) : null),
			getFiles: () => Object.keys(files).filter((p) => !p.startsWith(".")).map(file),
			read: async (f: { path: string }) => files[f.path],
			process: async (f: { path: string }, fn: (data: string) => string) => {
				const next = fn(files[f.path]);
				writes.push([f.path, next]);
				files[f.path] = next;
				return next;
			},
			create: async (p: string, data: string) => {
				if (p in files) throw new Error("File already exists.");
				writes.push([p, data]);
				files[p] = data;
				return file(p);
			},
			adapter: { exists: async (p: string) => p in files },
		},
	};
}

test("in the vault: adds, then updates; only AGENTS.md is written", async () => {
	const { vault, files, writes } = fakeVault({ "Note.md": "hello" });
	assert.equal(ADDED_NOTICE, "Added Orca Chat advice to AGENTS.md");
	assert.equal(UPDATED_NOTICE, "Updated Orca Chat advice in AGENTS.md");
	assert.equal(await appendAgentsAdvice(vault), ADDED_NOTICE);
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.equal(await appendAgentsAdvice(vault), UPDATED_NOTICE);
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.deepEqual(writes.map(([p]) => p), ["AGENTS.md"], "an unchanged block isn't rewritten");
	assert.deepEqual(Object.keys(files).sort(), ["AGENTS.md", "Note.md"]);
});

test("in the vault: appends to an existing AGENTS.md through Vault#process", async () => {
	const { vault, files, writes } = fakeVault({ "AGENTS.md": "Mine.\n" });
	assert.equal(await appendAgentsAdvice(vault), ADDED_NOTICE);
	assert.equal(files["AGENTS.md"], "Mine.\n\n" + BLOCK);
	assert.equal(writes.length, 1);
});

test("an edit that lands before the write is kept: the advice is applied to what process reads", async () => {
	const { vault, files } = fakeVault({ "AGENTS.md": "Mine.\n" });
	const read = vault.read;
	vault.read = async (f) => {
		const text = await read(f);
		files["AGENTS.md"] = "Mine, edited.\n";
		return text;
	};
	await appendAgentsAdvice(vault);
	assert.equal(files["AGENTS.md"], "Mine, edited.\n\n" + BLOCK);
});

test("a vault with a CLAUDE.md: the Notice says Claude Code may read that instead, and says nothing about imports", async () => {
	for (const claudeMd of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
		const { vault, files } = fakeVault({ [claudeMd]: "# mine\n" });
		const notice = await appendAgentsAdvice(vault);
		assert.equal(notice, `${ADDED_NOTICE}. ${CLAUDE_MD_NOTE}`);
		assert.equal(CLAUDE_MD_NOTE, "This vault has a CLAUDE.md, and current Claude Code may read that instead of AGENTS.md.");
		assert.ok(!/@AGENTS|import/i.test(notice));
		assert.equal(files[claudeMd], "# mine\n", "CLAUDE.md is never touched");
		assert.equal(await appendAgentsAdvice(vault), `${UPDATED_NOTICE}. ${CLAUDE_MD_NOTE}`);
	}
});

// A case-insensitive filesystem (macOS and Windows by default): the vault indexes `agents.md` under
// its own spelling, but the filesystem takes AGENTS.md to be the same file.
function insensitiveVault(files: Record<string, string>) {
	const fake = fakeVault(files);
	const same = (p: string) => Object.keys(files).find((k) => k.toLowerCase() === p.toLowerCase());
	const create = fake.vault.create;
	Object.assign(fake.vault, {
		create: async (p: string, data: string) => {
			if (same(p) !== undefined) throw new Error("File already exists.");
			return create(p, data);
		},
		adapter: { exists: async (p: string) => same(p) !== undefined },
	});
	return fake;
}

test("a differently-cased agents.md on a case-insensitive filesystem is written in place, not re-created", async () => {
	const { vault, files } = insensitiveVault({ "agents.md": "Mine.\n", "Notes/AGENTS.md": "not the root\n" });
	assert.equal(await appendAgentsAdvice(vault), ADDED_NOTICE);
	assert.equal(files["agents.md"], "Mine.\n\n" + BLOCK);
	assert.equal(await appendAgentsAdvice(vault), UPDATED_NOTICE);
	assert.equal(files["agents.md"], "Mine.\n\n" + BLOCK);
	assert.equal(files["Notes/AGENTS.md"], "not the root\n");
	assert.deepEqual(Object.keys(files).sort(), ["Notes/AGENTS.md", "agents.md"]);
});

test("on a case-sensitive filesystem a lowercase agents.md is a different file: AGENTS.md is created", async () => {
	const { vault, files } = fakeVault({ "agents.md": "Mine.\n" });
	assert.equal(await appendAgentsAdvice(vault), ADDED_NOTICE);
	assert.equal(files["AGENTS.md"], BLOCK);
	assert.equal(files["agents.md"], "Mine.\n");
});
