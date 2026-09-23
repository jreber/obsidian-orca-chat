import test from "node:test";
import assert from "node:assert/strict";
import { App, Plugin } from "./fakes/obsidian.ts";
import { loadLastSessionId, loadPairedCredential, saveLastSessionId, savePairedCredential } from "../src/orca-pairing.ts";

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
