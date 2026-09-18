import { PairingOfferSchema, type PairingOffer } from "./orca-remote/mobile-relay-pairing-offer";

type PairedCredential = PairingOffer;

// Base64url-encodes the pairing offer's JSON for use as a URL query value —
// deliberately NOT encodePairingOffer() from orca-remote/pairing.ts, which
// wraps the same encoding in an `orca://pair?code=...` deep link meant for a
// different transport (clipboard/QR paste), not a query param.
function encodeOfferForQuery(offer: PairedCredential): string {
	const json = JSON.stringify(PairingOfferSchema.parse(offer));
	return Buffer.from(json, "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function deriveHttpOrigin(endpoint: string): string {
	if (endpoint.startsWith("wss://")) return `https://${endpoint.slice("wss://".length)}`;
	if (endpoint.startsWith("ws://")) return `http://${endpoint.slice("ws://".length)}`;
	throw new Error(`Unrecognized pairing endpoint scheme: ${endpoint}`);
}

export function buildSingleSessionEmbedUrl(
	pairing: PairedCredential,
	sessionId: string,
	agent: string,
): string {
	const origin = deriveHttpOrigin(pairing.endpoint);
	// Param name is "session", not "sessionId" — matches Orca's
	// parseSingleSessionLocation() contract (single-session-pairing.ts).
	const params = new URLSearchParams({
		pairing: encodeOfferForQuery(pairing),
		session: sessionId,
		agent,
	});
	return `${origin}/single-session-index.html?${params.toString()}`;
}
