import { computeAgentSessionPayloadFingerprint } from "./orca-remote/agent-session-mutation-envelope";
import type { PairingOffer } from "./orca-remote/pairing";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	type RuntimeCapability,
} from "./orca-remote/protocol-version";
import {
	RemoteRuntimeClientError,
	sendRemoteRuntimeRequest,
	subscribeRemoteRuntimeRequest,
	type RemoteRuntimeSubscription,
} from "./orca-remote/remote-runtime-client";
import type { RuntimeRpcResponse } from "./orca-remote/runtime-rpc-envelope";
import type { PairedCredential } from "./orca-pairing";
import type { OrcaRepoSummary } from "./vault-project";

// Every agentSession.* method (and the session.tabs.* projection of an
// agent-session tab) is gated on this capability — see
// structured-agent-session-gate.ts / structured-agent-session-policy.ts and
// session-tab-agent-status-projection.ts on the host. Without it, tabs are
// hidden/placeholder'd and agentSession.* calls are refused with
// 'structured_agent_session_unsupported'.
//
// The Claude capability is required too: for a paired client that lacks it, the host's
// session.tabs.listAll projection hides every non-Codex agent-session tab. The plugin only creates
// Claude sessions, so without it the pane's liveness check never saw its own session and tore the
// live chat down as "session ended" ~15 s after New session.
export const STRUCTURED_AGENT_SESSION_CAPABILITIES: readonly RuntimeCapability[] = [
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
];

// The vendored transport (src/orca-remote/*) opens a fresh E2EE WebSocket
// per call: `sendRemoteRuntimeRequest` for one-shot request/response RPCs,
// `subscribeRemoteRuntimeRequest` for a long-lived streamed RPC. There is no
// persistent "connection" object to hold open across unrelated calls — every
// request carries the full `PairedCredential` and handshakes on its own. So
// connect()/disconnect() here are a thin credential holder plus bookkeeping
// to close any live subscriptions, not a real socket lifecycle.
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// agentSession.create may install and start Orca's session host, prepare and commit: a cold first
// create can take well over the read timeout.
const CREATE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBSCRIBE_START_TIMEOUT_MS = 10_000;

export class OrcaRemoteError extends Error {
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "OrcaRemoteError";
		this.cause = cause;
	}
}

function toOrcaRemoteError(err: unknown): OrcaRemoteError {
	if (err instanceof OrcaRemoteError) {
		return err;
	}
	if (err instanceof RemoteRuntimeClientError) {
		return new OrcaRemoteError(err.message, err);
	}
	if (err instanceof Error) {
		return new OrcaRemoteError(err.message, err);
	}
	return new OrcaRemoteError("Unknown Orca remote error", err);
}

// Orca turned the pairing itself away, as opposed to being unreachable: it answers a device token it
// doesn't know with `unauthorized`, and closes with 4001 when it can't decrypt the auth frame (the
// pairing holds another Orca's key) or the handshake is otherwise refused. A malformed handshake
// reply counts too: whatever answers at the pairing's address isn't the Orca that made it.
export function isPairingRejected(err: unknown): boolean {
	const cause = err instanceof OrcaRemoteError ? err.cause : err;
	if (!(cause instanceof RemoteRuntimeClientError)) return false;
	return (
		cause.code === "unauthorized" ||
		cause.closeCode === 4001 ||
		(cause.code === "invalid_runtime_response" && cause.pairingStage === "host-identity")
	);
}

function unwrapResponse<T>(response: RuntimeRpcResponse<T>): T {
	if (!response.ok) {
		throw new OrcaRemoteError(response.error.message, response.error);
	}
	return response.result;
}

// ─── session.tabs.* ──────────────────────────────────────────────────────
// `RuntimeMobileSessionAgentTab` from Orca's
// src/shared/runtime-mobile-session-tab-contracts.ts.
export type AgentSessionTab = {
	type: "agent-session";
	id: string;
	title: string;
	sessionId: string;
	replacesSessionId?: string;
	agent: "claude" | "codex";
	color?: string | null;
	isPinned?: boolean;
	isActive: boolean;
};

// The full session.tabs.list/subscribe response is a per-worktree snapshot
// containing a mix of tab types (terminal, markdown, file, browser,
// agent-session). We only care about the agent-session ones; other fields on
// the snapshot (activeTabId, tabGroups, etc.) are dropped here.
type SessionTabsSnapshot = {
	worktree: string;
	tabs: ReadonlyArray<{ type: string } & Record<string, unknown>>;
};

type SessionTabsStreamFrame =
	| ({ type: "snapshot" | "updated" } & SessionTabsSnapshot)
	| { type: "end" };

function filterAgentTabs(tabs: SessionTabsSnapshot["tabs"]): AgentSessionTab[] {
	return tabs.filter((tab): tab is AgentSessionTab => tab.type === "agent-session");
}

// ─── nativeChat.* ────────────────────────────────────────────────────────
// Mirrors Orca's src/shared/native-chat-types.ts (NativeChatMessage and the
// block union it carries). Vendored as plain types rather than imported,
// same as the rest of src/orca-remote/.
export type NativeChatRole = "user" | "assistant" | "tool" | "reasoning" | "system";
export type NativeChatSource = "transcript" | "hook" | "scrape";

export type NativeChatTextBlock = {
	type: "text";
	text: string;
	presentation?: string;
	tone?: string;
	providerFrame?: {
		provider: string;
		kind: string;
		payload: { head: string; byteLength: number; digest: string; truncated: boolean };
	};
};

export type NativeChatToolCallBlock = {
	type: "tool-call";
	name: string;
	input: unknown;
	state?: "running" | "completed" | "failed";
	mcpIdentity?: { server: string; tool: string };
	exitCode?: number;
	durationMs?: number;
	webSearchResults?: { title: string; url: string }[];
};

export type NativeChatEditPatchHunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
};

export type NativeChatToolResultBlock = {
	type: "tool-result";
	output: string;
	isError?: boolean;
	editPatch?: { filePath?: string; hunks: NativeChatEditPatchHunk[] };
};

export type NativeChatImageRefBlock = {
	type: "image-ref";
	path?: string;
	url?: string;
	alt?: string;
};

export type NativeChatSubagentState =
	| "working"
	| "idle"
	| "completed"
	| "failed"
	| "stopped"
	| "unverifiable";

export type NativeChatSubagentEntry = {
	id: string;
	label: string;
	state: NativeChatSubagentState;
	tokens?: number;
	startedAt?: number;
	settledAt?: number;
};

export type NativeChatSubagentGroupBlock = {
	type: "subagent-group";
	groupId: string;
	agents: NativeChatSubagentEntry[];
};

export type NativeChatBlock =
	| NativeChatTextBlock
	| NativeChatToolCallBlock
	| NativeChatToolResultBlock
	| NativeChatImageRefBlock
	| NativeChatSubagentGroupBlock;

export type NativeChatMessage = {
	id: string;
	role: NativeChatRole;
	blocks: NativeChatBlock[];
	timestamp: number | null;
	source: NativeChatSource;
	turnId?: string;
};

export type NativeChatTurnLifecycle = {
	state: "working" | "completed" | "interrupted";
	turnId: string;
	timestamp: number | null;
};

type NativeChatReadResult = {
	messages: NativeChatMessage[];
	hasMore: boolean;
	beforeOffset: number;
	lifecycle?: NativeChatTurnLifecycle;
};

// Streamed frame kinds differ semantically: 'snapshot'/'replacement' carry the
// full current window (replace whatever the client is holding), 'appended'
// carries only newly-added messages (merge, don't replace). Collapsing that
// distinction away would make the UI either drop history or duplicate
// messages, so subscribeNativeChat's callback is told which kind it got.
type NativeChatStreamFrame =
	| {
			type: "snapshot" | "replacement";
			messages: NativeChatMessage[];
			hasMore: boolean;
			beforeOffset: number;
			error?: string;
			lifecycle?: NativeChatTurnLifecycle;
			pending?: boolean;
	  }
	| { type: "appended"; messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle }
	| { type: "end" };

export type NativeChatMessageFrameKind = "snapshot" | "replacement" | "appended";

// ─── agentSession.* (structured sessions) ───────────────────────────────────
// Structured sessions (session.tabs.* type: 'agent-session') are host-owned
// and journal-backed — there is no PTY and nativeChat.* (a JSONL transcript
// tailer, see ~/repos/orca/src/main/native-chat/transcript-watch.ts) has zero
// awareness of them. This is a separate RPC family with its own leases,
// fencing and holds. Mirrors Orca's src/shared/agent-session-journal-types.ts
// and src/shared/agent-session-wire.ts.

/** Same shape as `AgentSessionTab` above (both mirror
 *  RuntimeMobileSessionAgentTab) — named distinctly here because it comes
 *  from session.tabs.listAll rather than the worktree-scoped session.tabs.list. */
export type StructuredSessionTab = AgentSessionTab;

type SessionTabsInventory = {
	snapshots: SessionTabsSnapshot[];
	authoritative?: true;
};

export type AgentJournalCursor = { epoch: string; sequence: number };

export type AgentJournalBoundedPayload = {
	head: string;
	byteLength: number;
	digest: string;
	truncated: boolean;
};

export type AgentJournalMessageItem = {
	kind: "message";
	role: NativeChatRole;
	blocks: NativeChatBlock[];
};

export type AgentJournalToolCallItem = {
	kind: "tool-call";
	name: string;
	input: unknown;
	state: "running" | "completed" | "failed";
	output?: AgentJournalBoundedPayload;
	mcpIdentity?: { server: string; tool: string };
	exitCode?: number;
	durationMs?: number;
	webSearchResults?: { title: string; url: string }[];
};

export type AgentJournalDiffItem = {
	kind: "diff";
	path: string;
	patch: AgentJournalBoundedPayload;
};

export type AgentJournalResolution = {
	state: "pending" | "resolved" | "cancelled";
	selectedOptionId: string | null;
	resolvedBy: string | null;
	resolvedAt: number | null;
};

export type AgentJournalPromptOption = { id: string; label: string; description?: string };

export type AgentJournalApprovalItem = {
	kind: "approval";
	title: string;
	detail: string | null;
	options: AgentJournalPromptOption[];
	resolution: AgentJournalResolution;
};

export type AgentJournalQuestion = {
	id: string;
	question: string;
	header?: string;
	multiSelect: boolean;
	options: AgentJournalPromptOption[];
	freeTextQuestionId?: string;
};

export type AgentJournalQuestionItem = {
	kind: "question";
	question: string;
	options: AgentJournalPromptOption[];
	questions?: AgentJournalQuestion[];
	freeTextQuestionId?: string;
	resolution: AgentJournalResolution;
};

export type AgentJournalStatusItem = {
	kind: "status";
	text: string;
	presentation?: string;
	tone?: string;
	turnLifecycle?: { turnId: string; state: "running" | "completed" };
	providerFrame?: { provider: string; kind: string; payload: AgentJournalBoundedPayload };
};

export type AgentJournalItemBody =
	| AgentJournalMessageItem
	| AgentJournalToolCallItem
	| AgentJournalDiffItem
	| AgentJournalApprovalItem
	| AgentJournalQuestionItem
	| AgentJournalStatusItem;

/** One reduced timeline entry. `sequence` orders the list; `observedAt` is the
 *  provider's own clock and may sort earlier than a later sequence when the
 *  row was recovered after a crash. */
export type AgentJournalRenderItem = {
	itemId: string;
	revision: number;
	body: AgentJournalItemBody;
	sequence: number;
	observedAt: number;
	recovered?: true;
};

export type AgentJournalDispatchState = "pending" | "accepted" | "rejected" | "unknown";

export type AgentJournalSubmission = {
	clientMessageId: string;
	fence: number;
	payloadFingerprint: string;
	dispatchState: AgentJournalDispatchState;
	providerItemId: string | null;
	reason: string | null;
	submittedAt: number;
	resolvedAt: number | null;
	recovered?: true;
};

export type AgentSessionBackgroundTaskRunState =
	| "working"
	| "monitoring"
	| "waiting"
	| "blocked"
	| "done"
	| "idle"
	| "unverifiable";

export type AgentSessionBackgroundTask = {
	id: string;
	kind: "agent" | "workflow" | "command" | "monitor" | "unknown";
	description?: string;
	name?: string;
	state?: AgentSessionBackgroundTaskRunState;
	startedAt?: number;
	totalTokens?: number;
};

export type AgentSessionBackgroundTaskState = {
	state: "monitoring";
	tasks?: AgentSessionBackgroundTask[];
	settledTasks?: AgentSessionBackgroundTask[];
	supportsTaskStop?: boolean;
	supportsStopAll?: boolean;
};

export type AgentSessionHistoryDirection = "tail" | "before" | "after";

export type AgentJournalResetReason =
	| "epoch_changed"
	| "cursor_ahead"
	| "cursor_compacted"
	| "journal_gap"
	| "schema_unreadable";

export type AgentSessionHistoryPage = {
	sessionId: string;
	epoch: string;
	/** Optimistic-concurrency checkpoint for this session, when the host has
	 *  one attached. This — not a dedicated "get fence" RPC — is the
	 *  client-visible source `sendAgentSessionMessage` reads before mutating;
	 *  `agentSession.subscribe`'s snapshot/reset events carry the same field
	 *  (required there instead of optional). */
	fence?: number;
	direction: AgentSessionHistoryDirection;
	items: AgentJournalRenderItem[];
	removedItemIds: string[];
	submissions: AgentJournalSubmission[];
	window: {
		oldest: AgentJournalCursor | null;
		newest: AgentJournalCursor | null;
		nextCursor: AgentJournalCursor;
	};
	liveCursor?: AgentJournalCursor;
	hasOlder: boolean;
	hasNewer: boolean;
	backgroundTasks?: AgentSessionBackgroundTaskState | null;
};

type AgentProviderSessionMetadata = { key: "session_id"; id: string };

export type AgentSessionHistoryResult =
	| { ok: true; page: AgentSessionHistoryPage; providerSession?: AgentProviderSessionMetadata }
	| {
			ok: false;
			reset: AgentJournalResetReason;
			page: AgentSessionHistoryPage;
			fence?: number;
			providerSession?: AgentProviderSessionMetadata;
	  };

export type AgentSessionSlashCommand = {
	name: string;
	kind: "command" | "skill";
	kindUnspecified?: true;
};

export type AgentSessionTurnActivity = { turnId: string; text: string };

export type AgentSessionHandoffStatus = {
	owner: "native" | "tui" | "none";
	direction: "to-tui" | "to-native" | null;
	phase: "idle" | "queued" | "switching" | "waiting-for-exit" | "failed";
	stage: "preparing" | "old-owner-stopped" | "new-owner-proving" | "recovering" | "manual-recovery" | null;
	operationId: string | null;
	hostLabel?: string;
	terminal?: { handle: string; tabId: string; paneKey: string; ptyId?: string };
	error?: {
		message: string;
		details?: string;
		recoverableOwner: "native" | "tui" | "none";
		canRetryProof?: boolean;
	};
};

export type AgentSessionJournalBatch = {
	cursor: AgentJournalCursor;
	items: AgentJournalRenderItem[];
	removedItemIds: string[];
	submissions: AgentJournalSubmission[];
};

/** `snapshot`/`reset` replace whatever the client is holding; `batch` carries
 *  only new/changed rows and must be merged, not used to replace the list. */
export type AgentSessionSubscribeEvent =
	| {
			type: "snapshot";
			sessionId: string;
			page: AgentSessionHistoryPage;
			fence: number;
			handoff?: AgentSessionHandoffStatus;
			backgroundTasks?: AgentSessionBackgroundTaskState | null;
			commands?: AgentSessionSlashCommand[] | null;
			activity?: AgentSessionTurnActivity | null;
	  }
	| {
			type: "batch";
			sessionId: string;
			batch: AgentSessionJournalBatch;
			fence?: number;
			handoff?: AgentSessionHandoffStatus;
			backgroundTasks?: AgentSessionBackgroundTaskState | null;
			commands?: AgentSessionSlashCommand[] | null;
			activity?: AgentSessionTurnActivity | null;
	  }
	| {
			type: "reset";
			sessionId: string;
			reset: AgentJournalResetReason;
			page: AgentSessionHistoryPage;
			fence: number;
			handoff?: AgentSessionHandoffStatus;
			backgroundTasks?: AgentSessionBackgroundTaskState | null;
			commands?: AgentSessionSlashCommand[] | null;
			activity?: AgentSessionTurnActivity | null;
	  }
	| { type: "end" };

export type AgentSessionSendBlock =
	| { type: "text"; text: string }
	| { type: "image-ref"; path?: string; url?: string; alt?: string };

type AgentSessionMutationEnvelope = {
	sessionId: string;
	clientOperationId: string;
	/** Null is only valid for agentSession.create's "must not exist yet" case;
	 *  every other mutating call — including send — fences against a real
	 *  number or the host refuses with 'agent_session_checkpoint_stale'. */
	expectedRuntimeFence: number | null;
	payloadFingerprint: string;
};

export type AgentSessionSendResult = { clientMessageId: string; submission: AgentJournalSubmission };

export type AgentSessionWireRefusal = {
	code: string;
	message: string;
	currentFence?: number;
	resolution?: AgentJournalResolution;
	currentRevision?: number;
};

export type AgentSessionMutationResult<TValue> =
	| { ok: true; replayed: boolean; fence: number; cursor: AgentJournalCursor; value: TValue }
	| { ok: false; refusal: AgentSessionWireRefusal };

export function buildCreateEnvelope(sessionId: string, worktree: string, agent: "claude"): AgentSessionMutationEnvelope {
	return {
		sessionId,
		// Same ledger shape as buildMutationEnvelope: 13-digit ms timestamp + 32 hex chars.
		clientOperationId: `${Date.now()}-${crypto.randomUUID().replace(/-/g, "")}`,
		// Create is the one mutation that must NOT fence: the session does not exist yet.
		expectedRuntimeFence: null,
		payloadFingerprint: computeAgentSessionPayloadFingerprint({
			method: "agentSession.create",
			sessionId,
			fields: { worktree, agent, resumeFrom: undefined },
		}),
	};
}

// "unknown": the create may or may not have happened (no answer, or Orca's own
// agent_session_operation_unknown); "failed": Orca answered that nothing was created.
type CreateOutcome =
	| { kind: "created"; value: { sessionId: string } }
	| { kind: "failed" | "unknown"; error: OrcaRemoteError };

function createOutcome(response: RuntimeRpcResponse<AgentSessionMutationResult<{ sessionId: string }>>): CreateOutcome {
	if (!response.ok) return { kind: "failed", error: new OrcaRemoteError(response.error.message, response.error) };
	const result = response.result;
	if (result.ok) return { kind: "created", value: { sessionId: result.value.sessionId } };
	const error = new OrcaRemoteError(
		`agentSession.create refused (${result.refusal.code}): ${result.refusal.message}`,
		result.refusal,
	);
	return { kind: result.refusal.code === "agent_session_operation_unknown" ? "unknown" : "failed", error };
}

export class OrcaRemoteClient {
	private credential: PairedCredential | null = null;
	private readonly openSubscriptions = new Set<RemoteRuntimeSubscription>();
	private readonly createTimeoutMs: number;

	// `createTimeoutMs` is for tests.
	constructor(options: { createTimeoutMs?: number } = {}) {
		this.createTimeoutMs = options.createTimeoutMs ?? CREATE_REQUEST_TIMEOUT_MS;
	}

	// No real socket to open up front (see file header) — this just stores the
	// credential every subsequent call needs. Kept as an explicit async step
	// (rather than a plain setter) so the API reads the same as a real connect
	// for whoever wires this into chat-view.ts next.
	async connect(credential: PairedCredential): Promise<void> {
		this.credential = credential;
	}

	disconnect(): void {
		for (const subscription of this.openSubscriptions) {
			subscription.close();
		}
		this.openSubscriptions.clear();
		this.credential = null;
	}

	private requireCredential(): PairingOffer {
		if (!this.credential) {
			throw new OrcaRemoteError("Not connected to Orca — call connect() first.");
		}
		return this.credential;
	}

	async listAgentTabs(worktree: string): Promise<AgentSessionTab[]> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<SessionTabsSnapshot>(
				credential,
				"session.tabs.list",
				{ worktree },
				DEFAULT_REQUEST_TIMEOUT_MS,
			);
			return filterAgentTabs(unwrapResponse(response).tabs);
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// Returns an unsubscribe function. onError fires for both transport
	// failures (socket dropped) and RPC-level failures received mid-stream;
	// after either, the subscription is done and no more onUpdate/onError
	// calls will follow. No automatic retry: the vendored transport does not
	// retry subscriptions itself, so building one here would be a parallel
	// (and untested) retry policy — surface the error and let the caller
	// decide whether to resubscribe.
	subscribeAgentTabs(
		worktree: string,
		onUpdate: (tabs: AgentSessionTab[]) => void,
		onError?: (error: OrcaRemoteError) => void,
	): () => void {
		const credential = this.requireCredential();
		let cancelled = false;
		let subscription: RemoteRuntimeSubscription | null = null;

		subscribeRemoteRuntimeRequest<SessionTabsStreamFrame>(
			credential,
			"session.tabs.subscribe",
			{ worktree },
			DEFAULT_SUBSCRIBE_START_TIMEOUT_MS,
			{
				onResponse: (response) => {
					if (!response.ok) {
						onError?.(new OrcaRemoteError(response.error.message, response.error));
						return;
					}
					const frame = response.result;
					if (frame.type === "end") {
						return;
					}
					onUpdate(filterAgentTabs(frame.tabs));
				},
				onError: (error) => onError?.(toOrcaRemoteError(error)),
			},
		)
			.then((sub) => {
				if (cancelled) {
					sub.close();
					return;
				}
				subscription = sub;
				this.openSubscriptions.add(sub);
			})
			.catch((err) => onError?.(toOrcaRemoteError(err)));

		return () => {
			cancelled = true;
			if (subscription) {
				this.openSubscriptions.delete(subscription);
				subscription.close();
				subscription = null;
			}
		};
	}

	async readNativeChat(agent: string, sessionId: string, limit?: number): Promise<NativeChatMessage[]> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<NativeChatReadResult>(
				credential,
				"nativeChat.readSession",
				{ agent, sessionId, ...(limit !== undefined ? { limit } : {}) },
				DEFAULT_REQUEST_TIMEOUT_MS,
			);
			return unwrapResponse(response).messages;
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// onMessage is told the frame kind because 'appended' must be merged, not
	// used to replace the client's current message list — see
	// NativeChatStreamFrame above.
	subscribeNativeChat(
		agent: string,
		sessionId: string,
		onMessage: (messages: NativeChatMessage[], kind: NativeChatMessageFrameKind) => void,
		onError?: (error: OrcaRemoteError) => void,
	): () => void {
		const credential = this.requireCredential();
		let cancelled = false;
		let subscription: RemoteRuntimeSubscription | null = null;

		subscribeRemoteRuntimeRequest<NativeChatStreamFrame>(
			credential,
			"nativeChat.subscribe",
			{ agent, sessionId },
			DEFAULT_SUBSCRIBE_START_TIMEOUT_MS,
			{
				onResponse: (response) => {
					if (!response.ok) {
						onError?.(new OrcaRemoteError(response.error.message, response.error));
						return;
					}
					const frame = response.result;
					if (frame.type === "end") {
						return;
					}
					if (frame.type !== "appended" && frame.error) {
						onError?.(new OrcaRemoteError(frame.error));
						return;
					}
					onMessage(frame.messages, frame.type);
				},
				onError: (error) => onError?.(toOrcaRemoteError(error)),
			},
		)
			.then((sub) => {
				if (cancelled) {
					sub.close();
					return;
				}
				subscription = sub;
				this.openSubscriptions.add(sub);
			})
			.catch((err) => onError?.(toOrcaRemoteError(err)));

		return () => {
			cancelled = true;
			if (subscription) {
				this.openSubscriptions.delete(subscription);
				subscription.close();
				subscription = null;
			}
		};
	}

	// ─── agentSession.* ──────────────────────────────────────────────────────

	// session.tabs.listAll returns one snapshot per worktree (plus any
	// non-worktree-scoped tabs); flatten and keep only the structured ones.
	async listAllAgentSessionTabs(): Promise<StructuredSessionTab[]> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<SessionTabsInventory>(
				credential,
				"session.tabs.listAll",
				null,
				DEFAULT_REQUEST_TIMEOUT_MS,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			const inventory = unwrapResponse(response);
			return inventory.snapshots.flatMap((snapshot) => filterAgentTabs(snapshot.tabs));
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	async listRepos(): Promise<OrcaRepoSummary[]> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<{ repos: OrcaRepoSummary[] }>(
				credential, "repo.list", null, DEFAULT_REQUEST_TIMEOUT_MS,
			);
			return unwrapResponse(response).repos;
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// kind must be explicit: Orca's repo.add defaults to 'git', which would refuse a plain folder.
	async addFolderRepo(path: string, displayName: string): Promise<OrcaRepoSummary> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<{ repo: OrcaRepoSummary }>(
				credential, "repo.add", { path, kind: "folder", displayName }, DEFAULT_REQUEST_TIMEOUT_MS,
			);
			return unwrapResponse(response).repo;
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	async listWorkspaces(repoId: string): Promise<{ id: string; path: string }[]> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<{ worktrees: { id: string; path: string }[] }>(
				credential, "worktree.list", { repo: `id:${repoId}` }, DEFAULT_REQUEST_TIMEOUT_MS,
			);
			return unwrapResponse(response).worktrees.map((w) => ({ id: w.id, path: w.path }));
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// The session id is generated here, so an outcome lost in transit (a timeout, a dropped socket, or
	// Orca's "may have been created" refusal) is recovered rather than reported as "not created" while
	// Orca goes on to finish the create: the SAME envelope is sent once more, which Orca's operation
	// ledger answers as a replay of the committed create, and failing that the id is looked up in
	// session.tabs.listAll. Only if neither finds it does the original failure stand.
	async createClaudeSession(workspaceId: string): Promise<{ sessionId: string }> {
		const credential = this.requireCredential();
		const sessionId = crypto.randomUUID();
		const worktree = `id:${workspaceId}`;
		const params = { envelope: buildCreateEnvelope(sessionId, worktree, "claude"), worktree, agent: "claude" };
		const send = () =>
			sendRemoteRuntimeRequest<AgentSessionMutationResult<{ sessionId: string }>>(
				credential,
				"agentSession.create",
				params,
				this.createTimeoutMs,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
		let outcome: CreateOutcome;
		try {
			outcome = createOutcome(await send());
		} catch (err) {
			outcome = { kind: "unknown", error: toOrcaRemoteError(err) };
		}
		if (outcome.kind === "unknown") {
			console.warn("[orca-chat] agentSession.create outcome unknown; checking whether Orca created it", outcome.error.message);
			const replay = await send().then(createOutcome, (err: unknown) => ({ kind: "unknown", error: toOrcaRemoteError(err) }) as const);
			if (replay.kind === "created") return replay.value;
			if (await this.hasAgentSession(sessionId)) return { sessionId };
		}
		if (outcome.kind === "created") return outcome.value;
		throw outcome.error;
	}

	// Whether session.tabs.listAll lists `sessionId`; false if the list itself fails.
	private async hasAgentSession(sessionId: string): Promise<boolean> {
		try {
			return (await this.listAllAgentSessionTabs()).some((tab) => tab.sessionId === sessionId);
		} catch {
			return false;
		}
	}

	// A plain one-shot read. No hold: agentSession.history's handler
	// (structured-agent-session.ts) never touches the hold registry — the
	// "retain-only, reading must never start a provider" comment on
	// agentSession.subscribe is about *that* method, not this one.
	async readAgentSessionHistory(
		sessionId: string,
		direction: AgentSessionHistoryDirection = "tail",
		cursor?: AgentJournalCursor,
		limit?: number,
	): Promise<AgentSessionHistoryResult> {
		const credential = this.requireCredential();
		try {
			const response = await sendRemoteRuntimeRequest<AgentSessionHistoryResult>(
				credential,
				"agentSession.history",
				{ sessionId, direction, ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) },
				DEFAULT_REQUEST_TIMEOUT_MS,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			return unwrapResponse(response);
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// NOTE on hold-before-subscribe: agentSession.subscribe's own handler
	// already takes a hold scoped to the stream itself (`streamHolder`,
	// released when the stream's connection closes — see
	// structured-agent-session.ts and structured-agent-session-hold.ts), so
	// the live stream is already retained for exactly as long as this
	// subscription is open. A *separate* client-initiated agentSession.hold
	// call was deliberately NOT added here: this vendored transport opens a
	// brand-new WebSocket per sendRemoteRuntimeRequest call and closes it the
	// instant the response arrives (remote-runtime-request-socket.ts calls
	// `ws.close()` in `finish()`), and the host releases a hold's registered
	// cleanup when ITS connection closes (`cleanupSubscriptionsForConnection`,
	// wired from relay-transport.ts's onConnectionClosed). A hold sent that
	// way would be released before agentSession.subscribe's own request even
	// went out, so it would protect nothing — it would just be a wasted round
	// trip that looks safe but isn't. If a future need arises for a hold that
	// outlives one call (e.g. a UI surface that reads history without
	// subscribing), it would have to be issued over the *same* connection as
	// something long-lived, using the subscription's own `sendRequest`.
	subscribeAgentSessionHistory(
		sessionId: string,
		onUpdate: (event: Exclude<AgentSessionSubscribeEvent, { type: "end" }>) => void,
		onError?: (error: OrcaRemoteError) => void,
	): () => void {
		const credential = this.requireCredential();
		let cancelled = false;
		let subscription: RemoteRuntimeSubscription | null = null;

		subscribeRemoteRuntimeRequest<AgentSessionSubscribeEvent>(
			credential,
			"agentSession.subscribe",
			{ sessionId },
			DEFAULT_SUBSCRIBE_START_TIMEOUT_MS,
			{
				onResponse: (response) => {
					if (!response.ok) {
						onError?.(new OrcaRemoteError(response.error.message, response.error));
						return;
					}
					const event = response.result;
					if (event.type === "end") {
						return;
					}
					onUpdate(event);
				},
				onError: (error) => onError?.(toOrcaRemoteError(error)),
			},
			{ clientCapabilities: STRUCTURED_AGENT_SESSION_CAPABILITIES },
		)
			.then((sub) => {
				if (cancelled) {
					sub.close();
					return;
				}
				subscription = sub;
				this.openSubscriptions.add(sub);
			})
			.catch((err) => onError?.(toOrcaRemoteError(err)));

		// Closing this subscription's socket is the release: it drops the
		// connection the host's `streamHolder` hold (and the stream's own
		// cleanup registration) is scoped to, so the host tears both down on
		// its connection-close path without a separate agentSession.release
		// call. See the hold note above.
		return () => {
			cancelled = true;
			if (subscription) {
				this.openSubscriptions.delete(subscription);
				subscription.close();
				subscription = null;
			}
		};
	}

	// Shared by every agentSession.* mutation (send, respondToApproval, respondToQuestion):
	// `expectedRuntimeFence` cannot be null for these (null only means "must not exist yet", valid
	// solely for agentSession.create — see MutationEnvelope's schema comment in
	// structured-agent-session-schemas.ts) so this reads the session's current fence off
	// agentSession.history's page.fence first. A fence that goes stale between the read and the
	// mutation is a normal race, not a bug here: the host refuses with
	// 'agent_session_checkpoint_stale' and the refusal carries currentFence for a caller that wants
	// to retry. `fingerprintMethod` is the fingerprint's own `method` field, which for the respond*
	// calls is NOT the RPC method name — mirrors Orca's own renderer client
	// (use-structured-agent-session-mutate.ts's `fingerprintMethod` argument).
	private async buildMutationEnvelope(
		sessionId: string,
		fingerprintMethod: string,
		fields: Record<string, unknown>,
	): Promise<AgentSessionMutationEnvelope> {
		const history = await this.readAgentSessionHistory(sessionId);
		const fence = history.page.fence;
		if (fence === undefined) {
			throw new OrcaRemoteError(
				`Session ${sessionId} has no runtime fence yet (host holds no attached session) — cannot mutate it.`,
			);
		}
		return {
			sessionId,
			// Orca's ledger requires this exact shape: /^(\d{13})-[0-9a-f]{32}$/ (13-digit ms
			// timestamp + 32 hex chars) — a plain UUID does not match and is refused outright
			// as agent_session_operation_invalid. crypto.randomUUID() minus its dashes is
			// exactly 32 hex chars, so it supplies the second half.
			clientOperationId: `${Date.now()}-${crypto.randomUUID().replace(/-/g, '')}`,
			expectedRuntimeFence: fence,
			payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: fingerprintMethod, sessionId, fields }),
		};
	}

	// Sends one user text message.
	async sendAgentSessionMessage(sessionId: string, text: string): Promise<void> {
		const credential = this.requireCredential();
		try {
			const body = {
				kind: "message" as const,
				role: "user" as const,
				blocks: [{ type: "text" as const, text }] satisfies AgentSessionSendBlock[],
			};
			const envelope = await this.buildMutationEnvelope(sessionId, "agentSession.send", { body });
			const response = await sendRemoteRuntimeRequest<AgentSessionMutationResult<AgentSessionSendResult>>(
				credential,
				"agentSession.send",
				{ envelope, body },
				DEFAULT_REQUEST_TIMEOUT_MS,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			const result = unwrapResponse(response);
			if (!result.ok) {
				throw new OrcaRemoteError(
					`agentSession.send refused (${result.refusal.code}): ${result.refusal.message}`,
					result.refusal,
				);
			}
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}

	// Resolves a pending approval or question item (structured-session equivalent of clicking a
	// button in Orca's own UI). `expectedRevision` is the revision the caller last saw on that item
	// — a stale revision is refused with 'agent_session_checkpoint_stale', same as a stale fence.
	async respondToPrompt(
		sessionId: string,
		kind: "approval" | "question",
		itemId: string,
		expectedRevision: number,
		optionId: string,
	): Promise<void> {
		const credential = this.requireCredential();
		try {
			const fields = { itemId, expectedRevision, optionId };
			const envelope = await this.buildMutationEnvelope(sessionId, `agentSession.respondTo:${kind}`, fields);
			const method = kind === "approval" ? "agentSession.respondToApproval" : "agentSession.respondToQuestion";
			const response = await sendRemoteRuntimeRequest<AgentSessionMutationResult<unknown>>(
				credential,
				method,
				{ envelope, ...fields },
				DEFAULT_REQUEST_TIMEOUT_MS,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			const result = unwrapResponse(response);
			if (!result.ok) {
				throw new OrcaRemoteError(`${method} refused (${result.refusal.code}): ${result.refusal.message}`, result.refusal);
			}
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}
}
