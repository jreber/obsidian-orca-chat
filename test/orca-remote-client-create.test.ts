import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateEnvelope } from "../src/orca-remote-client.ts";
import { computeAgentSessionPayloadFingerprint } from "../src/orca-remote/agent-session-mutation-envelope.ts";

test("create envelope has a null fence and the create fingerprint Orca recomputes", () => {
	const env = buildCreateEnvelope("sess-1", "id:ws-1", "claude");
	assert.equal(env.sessionId, "sess-1");
	assert.equal(env.expectedRuntimeFence, null);
	assert.match(env.clientOperationId, /^\d{13}-[0-9a-f]{32}$/);
	assert.equal(
		env.payloadFingerprint,
		computeAgentSessionPayloadFingerprint({
			method: "agentSession.create",
			sessionId: "sess-1",
			fields: { worktree: "id:ws-1", agent: "claude", resumeFrom: undefined },
		}),
	);
});

test("an omitted resumeFrom fingerprints the same as an explicit undefined", () => {
	const a = computeAgentSessionPayloadFingerprint({
		method: "agentSession.create",
		sessionId: "s",
		fields: { worktree: "id:w", agent: "claude" },
	});
	const b = computeAgentSessionPayloadFingerprint({
		method: "agentSession.create",
		sessionId: "s",
		fields: { worktree: "id:w", agent: "claude", resumeFrom: undefined },
	});
	assert.equal(a, b);
});
