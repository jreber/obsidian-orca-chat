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

// Obsidian's Plugin#saveData overwrites the whole data.json blob, so every
// read-modify-write here loads first and spreads the rest through, keeping
// room for future settings to live alongside pairedCredential.
interface OrcaChatPluginData {
	pairedCredential: PairedCredential | null;
	lastSessionId?: string | null;
}

async function loadPluginData(plugin: Plugin): Promise<Partial<OrcaChatPluginData>> {
	return ((await plugin.loadData()) as Partial<OrcaChatPluginData> | null) ?? {};
}

// Serializes this module's read-modify-writes per plugin, so two of them (say, from a closed pane's
// late create and a reopened pane) can't both load before either saves and lose one update.
const pendingUpdates = new WeakMap<Plugin, Promise<unknown>>();

function updatePluginData<T>(plugin: Plugin, update: (data: Partial<OrcaChatPluginData>) => Promise<T>): Promise<T> {
	const run = (pendingUpdates.get(plugin) ?? Promise.resolve()).then(async () => update(await loadPluginData(plugin)));
	pendingUpdates.set(plugin, run.catch(() => {}));
	return run;
}

export function savePairedCredential(plugin: Plugin, credential: PairedCredential): Promise<void> {
	return updatePluginData(plugin, async (data) => {
		await plugin.saveData({ ...data, pairedCredential: credential } satisfies OrcaChatPluginData);
	});
}

// Queued behind any pending write, so a read never sees an id that a write already started replacing.
export function loadLastSessionId(plugin: Plugin): Promise<string | null> {
	return updatePluginData(plugin, async (data) => data.lastSessionId ?? null);
}

function withLastSessionId(data: Partial<OrcaChatPluginData>, sessionId: string | null): OrcaChatPluginData {
	return { ...data, pairedCredential: data.pairedCredential ?? null, lastSessionId: sessionId };
}

export function saveLastSessionId(plugin: Plugin, sessionId: string | null): Promise<void> {
	return updatePluginData(plugin, (data) => plugin.saveData(withLastSessionId(data, sessionId)));
}

// Stores `next` only if `accept` approves the stored id at write time; returns whether it did.
export function saveLastSessionIdIf(
	plugin: Plugin,
	accept: (stored: string | null) => boolean,
	next: string | null,
): Promise<boolean> {
	return updatePluginData(plugin, async (data) => {
		if (!accept(data.lastSessionId ?? null)) return false;
		await plugin.saveData(withLastSessionId(data, next));
		return true;
	});
}

// Stores `next` only if the stored id is still `expected`; returns whether it did.
export function compareAndSaveLastSessionId(plugin: Plugin, expected: string | null, next: string | null): Promise<boolean> {
	return saveLastSessionIdIf(plugin, (stored) => stored === expected, next);
}

export async function loadPairedCredential(plugin: Plugin): Promise<PairedCredential | null> {
	const data = await loadPluginData(plugin);
	return data.pairedCredential ?? null;
}
