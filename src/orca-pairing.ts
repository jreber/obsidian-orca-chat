import { Plugin } from "obsidian";
import { decodePairingOffer, type PairingOffer } from "./orca-remote/pairing";

// Whatever decodePairingOffer's schema (PairingOfferSchema) actually produces —
// deviceToken + publicKeyB64 + endpoint are the long-lived credential; the rest
// (pairedDeviceId, scope, relay) ride along unchanged. Do not add fields here
// without adding them to the vendored schema first.
export type PairedCredential = PairingOffer;

export class OrcaPairingError extends Error {
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "OrcaPairingError";
		this.cause = cause;
	}
}

export function decodePairingUrl(url: string): PairedCredential {
	try {
		return decodePairingOffer(url);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid Orca pairing URL";
		throw new OrcaPairingError(message, err);
	}
}

// The pairing and the last session are per device: each computer pairs with its own Orca, and a
// vault synced between computers (iCloud, Obsidian Sync, git) must not carry one machine's pairing
// or session to another. So both live in Obsidian's per-device, per-vault local storage
// (App#saveLocalStorage, which is not synced), not in the plugin's synced data.json. data.json keeps
// any other settings.
export const PAIRED_CREDENTIAL_KEY = "orca-chat:paired-credential";
export const LAST_SESSION_ID_KEY = "orca-chat:last-session-id";
// Set once this device has taken over (or declined) data.json's copies. data.json is never imported
// again after that, so a synced data.json another machine writes later can't change this device.
export const DEVICE_STORAGE_MIGRATED_KEY = "orca-chat:device-storage-migrated";

// App#loadLocalStorage / App#saveLocalStorage (public since Obsidian 1.8.7).
type DeviceStorage = {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): unknown;
};

function deviceStorage(plugin: Plugin): DeviceStorage {
	return plugin.app as unknown as DeviceStorage;
}

function loadDeviceValue(plugin: Plugin, key: string): unknown {
	return deviceStorage(plugin).loadLocalStorage(key) ?? null;
}

// Awaited, so a store that writes asynchronously (the tests' fake, to hold a write) is ordered too.
async function saveDeviceValue(plugin: Plugin, key: string, value: unknown): Promise<void> {
	await deviceStorage(plugin).saveLocalStorage(key, value);
}

// The fields earlier versions kept in data.json.
type LegacyPluginData = { pairedCredential?: PairedCredential | null; lastSessionId?: string | null } & Record<string, unknown>;

// Moves a pairing and last session that earlier versions kept in data.json into this device's
// storage, once, and removes them from data.json. A value this device already has (only possible
// when an earlier run was interrupted part-way) is never overwritten. After the first run on a
// device, copies found in data.json (say, synced from a machine still on an older version) are only
// removed, never imported.
// A synced data.json held the pairing of whichever computer paired last, so the moved pairing can be
// another computer's. Nothing here can tell; when that computer's Orca rejects it, the pane says to
// re-pair this computer (see isPairingRejected).
async function migrateToDeviceStorage(plugin: Plugin): Promise<void> {
	const migrated = loadDeviceValue(plugin, DEVICE_STORAGE_MIGRATED_KEY) === true;
	let data: LegacyPluginData;
	try {
		data = ((await plugin.loadData()) as LegacyPluginData | null) ?? {};
	} catch (err) {
		// Before the first migration, whether there is anything to import is unknown: fail (and retry
		// next time). After it, only a cleanup is missed.
		if (!migrated) throw err;
		console.warn("[orca-chat] couldn't read data.json to remove old pairing fields");
		return;
	}
	if (!migrated) {
		if (data.pairedCredential && loadDeviceValue(plugin, PAIRED_CREDENTIAL_KEY) === null) {
			await saveDeviceValue(plugin, PAIRED_CREDENTIAL_KEY, data.pairedCredential);
		}
		if (data.lastSessionId && loadDeviceValue(plugin, LAST_SESSION_ID_KEY) === null) {
			await saveDeviceValue(plugin, LAST_SESSION_ID_KEY, data.lastSessionId);
		}
		await saveDeviceValue(plugin, DEVICE_STORAGE_MIGRATED_KEY, true);
	}
	if (!("pairedCredential" in data) && !("lastSessionId" in data)) return;
	const { pairedCredential: _credential, lastSessionId: _sessionId, ...rest } = data;
	try {
		await plugin.saveData(rest);
	} catch {
		// Never log the data itself: it holds the credential. Removal is retried on the next load.
		console.warn("[orca-chat] couldn't remove the old pairing fields from data.json");
	}
}

// Serializes this module's read-modify-writes per plugin, so two of them (say, from a closed pane's
// late create and a reopened pane) can't both read before either writes and lose one update. The
// first operation on a plugin runs the data.json migration; a failed migration is retried by the next.
const pendingUpdates = new WeakMap<Plugin, Promise<unknown>>();
const migrations = new WeakMap<Plugin, Promise<void>>();

function ensureMigrated(plugin: Plugin): Promise<void> {
	let migration = migrations.get(plugin);
	if (!migration) {
		migration = migrateToDeviceStorage(plugin);
		migrations.set(plugin, migration);
		migration.catch(() => migrations.delete(plugin));
	}
	return migration;
}

function queued<T>(plugin: Plugin, run: () => Promise<T> | T): Promise<T> {
	const next = (pendingUpdates.get(plugin) ?? Promise.resolve()).then(() => ensureMigrated(plugin)).then(run);
	pendingUpdates.set(plugin, next.catch(() => {}));
	return next;
}

// Called on plugin load, so data.json loses the old fields even if no pane is opened.
export function migratePluginStorage(plugin: Plugin): Promise<void> {
	return queued(plugin, () => {});
}

export function savePairedCredential(plugin: Plugin, credential: PairedCredential): Promise<void> {
	return queued(plugin, () => saveDeviceValue(plugin, PAIRED_CREDENTIAL_KEY, credential));
}

export function loadPairedCredential(plugin: Plugin): Promise<PairedCredential | null> {
	return queued(plugin, () => (loadDeviceValue(plugin, PAIRED_CREDENTIAL_KEY) as PairedCredential | null) ?? null);
}

function storedSessionId(plugin: Plugin): string | null {
	const id = loadDeviceValue(plugin, LAST_SESSION_ID_KEY);
	return typeof id === "string" ? id : null;
}

// Queued behind any pending write, so a read never sees an id that a write already started replacing.
export function loadLastSessionId(plugin: Plugin): Promise<string | null> {
	return queued(plugin, () => storedSessionId(plugin));
}

export function saveLastSessionId(plugin: Plugin, sessionId: string | null): Promise<void> {
	return queued(plugin, () => saveDeviceValue(plugin, LAST_SESSION_ID_KEY, sessionId));
}

// Stores `next` only if `accept` approves the stored id at write time; returns whether it did.
export function saveLastSessionIdIf(
	plugin: Plugin,
	accept: (stored: string | null) => boolean,
	next: string | null,
): Promise<boolean> {
	return queued(plugin, async () => {
		if (!accept(storedSessionId(plugin))) return false;
		await saveDeviceValue(plugin, LAST_SESSION_ID_KEY, next);
		return true;
	});
}

// Stores `next` only if the stored id is still `expected`; returns whether it did.
export function compareAndSaveLastSessionId(plugin: Plugin, expected: string | null, next: string | null): Promise<boolean> {
	return saveLastSessionIdIf(plugin, (stored) => stored === expected, next);
}
