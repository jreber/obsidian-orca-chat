import test from "node:test";
import assert from "node:assert/strict";
import { App, Plugin } from "./fakes/obsidian.ts";
import {
	compareAndSaveLastSessionId,
	loadLastSessionId,
	loadPairedCredential,
	saveLastSessionId,
	savePairedCredential,
} from "../src/orca-pairing.ts";

test("last session id round-trips and null clears it", async () => {
	const plugin = new Plugin(new App());
	assert.equal(await loadLastSessionId(plugin as never), null);
	await saveLastSessionId(plugin as never, "sess-9");
	assert.equal(await loadLastSessionId(plugin as never), "sess-9");
	await saveLastSessionId(plugin as never, null);
	assert.equal(await loadLastSessionId(plugin as never), null);
});

test("saving the session id keeps the paired credential and vice versa", async () => {
	const plugin = new Plugin(new App());
	const cred = { v: 2, endpoint: "ws://x", deviceToken: "t", publicKeyB64: "k", scope: "runtime" } as never;
	await savePairedCredential(plugin as never, cred);
	await saveLastSessionId(plugin as never, "s1");
	assert.deepEqual(await loadPairedCredential(plugin as never), cred);
	await savePairedCredential(plugin as never, cred);
	assert.equal(await loadLastSessionId(plugin as never), "s1");
});

test("compare-and-save stores the new id when the stored id still matches", async () => {
	const plugin = new Plugin(new App());
	await saveLastSessionId(plugin as never, "s1");
	assert.equal(await compareAndSaveLastSessionId(plugin as never, "s1", "s2"), true);
	assert.equal(await loadLastSessionId(plugin as never), "s2");
});

test("compare-and-save treats a missing id as null", async () => {
	const plugin = new Plugin(new App());
	assert.equal(await compareAndSaveLastSessionId(plugin as never, null, "s2"), true);
	assert.equal(await loadLastSessionId(plugin as never), "s2");
});

test("compare-and-save leaves a changed stored id alone", async () => {
	const plugin = new Plugin(new App());
	await saveLastSessionId(plugin as never, "newer");
	assert.equal(await compareAndSaveLastSessionId(plugin as never, "s1", "s2"), false);
	assert.equal(await loadLastSessionId(plugin as never), "newer");
});

test("compare-and-save keeps the paired credential", async () => {
	const plugin = new Plugin(new App());
	const cred = { v: 2, endpoint: "ws://x", deviceToken: "t", publicKeyB64: "k", scope: "runtime" } as never;
	await savePairedCredential(plugin as never, cred);
	assert.equal(await compareAndSaveLastSessionId(plugin as never, null, "s2"), true);
	assert.deepEqual(await loadPairedCredential(plugin as never), cred);
	assert.equal(await loadLastSessionId(plugin as never), "s2");
});

test("compare-and-save can't interleave with another write to the same data", async () => {
	const plugin = new Plugin(new App());
	await saveLastSessionId(plugin as never, "s1");
	// Both start from s1; the save queued first wins and the compare then sees it changed.
	const [, swapped] = await Promise.all([
		saveLastSessionId(plugin as never, "newer"),
		compareAndSaveLastSessionId(plugin as never, "s1", "late"),
	]);
	assert.equal(swapped, false);
	assert.equal(await loadLastSessionId(plugin as never), "newer");
});
