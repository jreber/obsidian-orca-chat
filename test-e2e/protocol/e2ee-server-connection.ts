import type { WebSocket } from "ws";
import type nacl from "tweetnacl";
import { deriveSharedKey, encrypt, decrypt, publicKeyFromBase64 } from "../../src/orca-remote/e2ee-crypto";

export interface ServerConnection {
	deviceToken: string;
	// What the client advertised in its e2ee_auth frame; the real host gates session.tabs.* and
	// agentSession.* on these per connection.
	clientCapabilities: readonly string[];
	sendEncrypted(payload: unknown): void;
}

// Host side of the same E2EE handshake src/orca-remote/remote-runtime-request-socket.ts drives from
// the client: plaintext hello/ready, then an encrypted auth/authenticated exchange. Every decrypted
// frame received after that is handed to `onRpc` as a parsed JSON object.
export function acceptOrcaConnection(
	ws: WebSocket,
	serverKeyPair: nacl.BoxKeyPair,
	onRpc: (conn: ServerConnection, request: Record<string, unknown>) => void,
): void {
	let sharedKey: Uint8Array | null = null;
	let conn: ServerConnection | null = null;

	ws.on("message", (raw) => {
		const text = raw.toString("utf-8");

		if (!sharedKey) {
			const hello = JSON.parse(text) as { type?: string; publicKeyB64?: string };
			if (hello.type !== "e2ee_hello" || !hello.publicKeyB64) return;
			sharedKey = deriveSharedKey(serverKeyPair.secretKey, publicKeyFromBase64(hello.publicKeyB64));
			ws.send(JSON.stringify({ type: "e2ee_ready" }));
			return;
		}

		const plaintext = decrypt(text, sharedKey);
		if (plaintext === null) return;
		const frame = JSON.parse(plaintext) as Record<string, unknown>;

		if (!conn) {
			if (frame.type !== "e2ee_auth") return;
			const key = sharedKey;
			conn = {
				deviceToken: String(frame.deviceToken ?? ""),
				clientCapabilities: Array.isArray(frame.clientCapabilities) ? frame.clientCapabilities.map(String) : [],
				sendEncrypted: (payload) => ws.send(encrypt(JSON.stringify(payload), key)),
			};
			conn.sendEncrypted({ type: "e2ee_authenticated" });
			return;
		}

		onRpc(conn, frame);
	});
}
