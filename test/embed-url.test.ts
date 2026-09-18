import test from "node:test";
import assert from "node:assert/strict";
import { buildSingleSessionEmbedUrl } from "../src/embed-url.ts";
import {
	PAIRING_OFFER_VERSION,
	PairingOfferSchema,
	type PairingOffer,
} from "../src/orca-remote/mobile-relay-pairing-offer.ts";

const baseOffer: PairingOffer = PairingOfferSchema.parse({
	v: PAIRING_OFFER_VERSION,
	deviceToken: "token-abc",
	publicKeyB64: "cHVibGljS2V5",
	endpoint: "ws://192.168.1.50:4931",
});

test("buildSingleSessionEmbedUrl derives an http origin from a ws:// endpoint", () => {
	const url = buildSingleSessionEmbedUrl(baseOffer, "session-1", "claude");
	assert.equal(url.startsWith("http://192.168.1.50:4931/single-session-index.html?"), true);
});

test("buildSingleSessionEmbedUrl derives an https origin from a wss:// endpoint", () => {
	const offer = { ...baseOffer, endpoint: "wss://orca.example.com:9443" };
	const url = buildSingleSessionEmbedUrl(offer, "session-1", "claude");
	assert.equal(url.startsWith("https://orca.example.com:9443/single-session-index.html?"), true);
});

test("buildSingleSessionEmbedUrl includes session and agent as query params", () => {
	const url = buildSingleSessionEmbedUrl(baseOffer, "session-42", "codex");
	const parsed = new URL(url);
	assert.equal(parsed.searchParams.get("session"), "session-42");
	assert.equal(parsed.searchParams.get("agent"), "codex");
});

test("buildSingleSessionEmbedUrl encodes the pairing offer such that it round-trips through JSON.parse(atob(...))", () => {
	const url = buildSingleSessionEmbedUrl(baseOffer, "session-1", "claude");
	const parsed = new URL(url);
	const pairingParam = parsed.searchParams.get("pairing");
	assert.ok(pairingParam);
	const base64 = pairingParam.replace(/-/g, "+").replace(/_/g, "/");
	const decoded = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
	assert.equal(decoded.deviceToken, "token-abc");
	assert.equal(decoded.endpoint, "ws://192.168.1.50:4931");
});

test("buildSingleSessionEmbedUrl throws for an endpoint with an unrecognized scheme", () => {
	const offer = { ...baseOffer, endpoint: "tcp://192.168.1.50:4931" };
	assert.throws(() => buildSingleSessionEmbedUrl(offer, "session-1", "claude"));
});
