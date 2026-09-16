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
}

async function loadPluginData(plugin: Plugin): Promise<Partial<OrcaChatPluginData>> {
	return ((await plugin.loadData()) as Partial<OrcaChatPluginData> | null) ?? {};
}

export async function savePairedCredential(plugin: Plugin, credential: PairedCredential): Promise<void> {
	const data = await loadPluginData(plugin);
	await plugin.saveData({ ...data, pairedCredential: credential } satisfies OrcaChatPluginData);
}

export async function loadPairedCredential(plugin: Plugin): Promise<PairedCredential | null> {
	const data = await loadPluginData(plugin);
	return data.pairedCredential ?? null;
}
