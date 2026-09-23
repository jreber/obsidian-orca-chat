import test from "node:test";
import assert from "node:assert/strict";
import { App, Plugin } from "./fakes/obsidian.ts";
import {
	compareAndSaveLastSessionId,
	DEVICE_STORAGE_MIGRATED_KEY,
	LAST_SESSION_ID_KEY,
	loadLastSessionId,
	loadPairedCredential,
	migratePluginStorage,
	PAIRED_CREDENTIAL_KEY,
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

test("loading the session id waits for a write already queued, so it never reads a stale id", async () => {
	const app = new App();
	const plugin = new Plugin(app);
	await saveLastSessionId(plugin as never, "old");
	const realSave = app.saveLocalStorage.bind(app);
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	app.saveLocalStorage = async (key: string, data: unknown) => {
		await held;
		return realSave(key, data);
	};
	const saving = saveLastSessionId(plugin as never, "new");
	const loading = loadLastSessionId(plugin as never);
	release();
	await saving;
	assert.equal(await loading, "new");
});

// --- Per-device storage: never in the synced data.json ---

const CRED_A = { v: 2, endpoint: "ws://127.0.0.1:1111", deviceToken: "token-a", publicKeyB64: "ka", scope: "runtime" };
const CRED_B = { v: 2, endpoint: "ws://127.0.0.1:2222", deviceToken: "token-b", publicKeyB64: "kb", scope: "runtime" };

function pluginWithData(data: unknown) {
	const app = new App();
	const plugin = new Plugin(app);
	void plugin.saveData(data);
	return { app, plugin };
}

test("pairing and last session are stored per device, and never written to data.json", async () => {
	const { app, plugin } = pluginWithData({ someSetting: 1 });
	await savePairedCredential(plugin as never, CRED_A as never);
	await saveLastSessionId(plugin as never, "s1");
	assert.deepEqual(app.loadLocalStorage(PAIRED_CREDENTIAL_KEY), CRED_A);
	assert.equal(app.loadLocalStorage(LAST_SESSION_ID_KEY), "s1");
	assert.deepEqual(await plugin.loadData(), { someSetting: 1 });
});

test("migration: data.json's pairing and last session move to this device and leave data.json, other settings kept", async () => {
	const { app, plugin } = pluginWithData({ pairedCredential: CRED_A, lastSessionId: "s1", someSetting: 1 });
	await migratePluginStorage(plugin as never);
	assert.deepEqual(await loadPairedCredential(plugin as never), CRED_A);
	assert.equal(await loadLastSessionId(plugin as never), "s1");
	assert.deepEqual(await plugin.loadData(), { someSetting: 1 });
	assert.equal(app.loadLocalStorage(DEVICE_STORAGE_MIGRATED_KEY), true);
});

test("migration: the first operation migrates even without the on-load call", async () => {
	const { plugin } = pluginWithData({ pairedCredential: CRED_A, lastSessionId: "s1" });
	assert.equal(await loadLastSessionId(plugin as never), "s1");
	assert.deepEqual(await plugin.loadData(), {});
});

test("migration: a device's own pairing and session win; data.json's copies are only removed", async () => {
	const { app, plugin } = pluginWithData({ pairedCredential: CRED_A, lastSessionId: "sA" });
	app.saveLocalStorage(PAIRED_CREDENTIAL_KEY, CRED_B);
	app.saveLocalStorage(LAST_SESSION_ID_KEY, "sB");
	await migratePluginStorage(plugin as never);
	assert.deepEqual(await loadPairedCredential(plugin as never), CRED_B);
	assert.equal(await loadLastSessionId(plugin as never), "sB");
	assert.deepEqual(await plugin.loadData(), {});
});

test("migration: a synced session id isn't taken by a device that has its own pairing", async () => {
	const { app, plugin } = pluginWithData({ lastSessionId: "sA" });
	app.saveLocalStorage(PAIRED_CREDENTIAL_KEY, CRED_B);
	await migratePluginStorage(plugin as never);
	assert.equal(await loadLastSessionId(plugin as never), null);
	assert.deepEqual(await plugin.loadData(), {});
});

test("a synced data.json written later by another machine never changes this device's pairing or session", async () => {
	const { app, plugin } = pluginWithData({});
	await migratePluginStorage(plugin as never);
	await savePairedCredential(plugin as never, CRED_B as never);
	await saveLastSessionId(plugin as never, "sB");
	// Another machine, still on an older version, syncs its pairing and session into data.json.
	await plugin.saveData({ pairedCredential: CRED_A, lastSessionId: "sA", someSetting: 2 });
	assert.deepEqual(await loadPairedCredential(plugin as never), CRED_B);
	assert.equal(await loadLastSessionId(plugin as never), "sB");
	// The next load (a new plugin instance on this device) removes the copies without importing them.
	const reloaded = new Plugin(app);
	await reloaded.saveData(await plugin.loadData());
	await migratePluginStorage(reloaded as never);
	assert.deepEqual(await loadPairedCredential(reloaded as never), CRED_B);
	assert.equal(await loadLastSessionId(reloaded as never), "sB");
	assert.deepEqual(await reloaded.loadData(), { someSetting: 2 });
});

test("a device that was unpaired when it migrated doesn't pick up a pairing synced in later", async () => {
	const { app, plugin } = pluginWithData({});
	await migratePluginStorage(plugin as never);
	const reloaded = new Plugin(app);
	await reloaded.saveData({ pairedCredential: CRED_A, lastSessionId: "sA" });
	assert.equal(await loadPairedCredential(reloaded as never), null);
	assert.equal(await loadLastSessionId(reloaded as never), null);
	assert.deepEqual(await reloaded.loadData(), {});
});

test("migration: a data.json that can't be read is retried, and nothing is marked migrated", async () => {
	const { app, plugin } = pluginWithData({ pairedCredential: CRED_A });
	const realLoad = plugin.loadData.bind(plugin);
	plugin.loadData = async () => {
		throw new Error("loadData failed");
	};
	await assert.rejects(loadPairedCredential(plugin as never), /loadData failed/);
	assert.equal(app.loadLocalStorage(DEVICE_STORAGE_MIGRATED_KEY), null);
	plugin.loadData = realLoad;
	assert.deepEqual(await loadPairedCredential(plugin as never), CRED_A);
});

test("migration: a failed data.json cleanup keeps the moved values and never logs the credential", async () => {
	const { plugin } = pluginWithData({ pairedCredential: CRED_A, lastSessionId: "s1" });
	plugin.saveData = async () => {
		throw new Error("read-only");
	};
	const logged: unknown[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => void logged.push(...args);
	try {
		assert.deepEqual(await loadPairedCredential(plugin as never), CRED_A);
	} finally {
		console.warn = warn;
	}
	assert.equal(logged.length, 1);
	assert.ok(!JSON.stringify(logged.map(String)).includes("token-a"));
});

test("compare-and-save still can't interleave with a write held in device storage", async () => {
	const app = new App();
	const plugin = new Plugin(app);
	await saveLastSessionId(plugin as never, "s1");
	const realSave = app.saveLocalStorage.bind(app);
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	app.saveLocalStorage = async (key: string, data: unknown) => {
		await held;
		return realSave(key, data);
	};
	const saving = saveLastSessionId(plugin as never, "newer");
	const swapping = compareAndSaveLastSessionId(plugin as never, "s1", "late");
	release();
	await saving;
	assert.equal(await swapping, false);
	assert.equal(await loadLastSessionId(plugin as never), "newer");
});
