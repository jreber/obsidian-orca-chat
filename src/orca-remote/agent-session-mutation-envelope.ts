// Vendored (adapted) from Orca's src/shared/agent-session-mutation-envelope.ts.
//
// Only the client-usable half of that file: computing the payload fingerprint
// a mutation envelope carries. The full file also defines
// `agentSessionFingerprintConflict` and `admitAgentSessionMutation`, which
// depend on the durable operation ledger and lease types the host alone
// owns (agent-session-operation-ledger.ts, agent-session-lease-adjudication.ts)
// — dropped here, same as the rest of this vendoring set drops main-process-only
// code. A mismatched fingerprint makes the host reject the call, so this MUST
// stay byte-for-byte identical to the source's canonicalization logic.

import { createHash } from "node:crypto";

/**
 * Stable digest over the fields that define what this call DOES. Keys are
 * emitted in sorted order at every depth so two peers serializing the same
 * request in different property order agree, and an undefined field is
 * dropped rather than hashed as present-but-empty.
 */
export function computeAgentSessionPayloadFingerprint(input: {
	method: string;
	sessionId: string;
	fields: Record<string, unknown>;
}): string {
	const canonical = canonicalize({
		method: input.method,
		sessionId: input.sessionId,
		fields: input.fields,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
}
