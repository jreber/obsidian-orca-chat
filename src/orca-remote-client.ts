import type { PairingOffer } from "./orca-remote/pairing";
import {
	RemoteRuntimeClientError,
	sendRemoteRuntimeRequest,
	subscribeRemoteRuntimeRequest,
	type RemoteRuntimeSubscription,
} from "./orca-remote/remote-runtime-client";
import type { RuntimeRpcResponse } from "./orca-remote/runtime-rpc-envelope";
import type { PairedCredential } from "./orca-pairing";

// The vendored transport (src/orca-remote/*) opens a fresh E2EE WebSocket
// per call: `sendRemoteRuntimeRequest` for one-shot request/response RPCs,
// `subscribeRemoteRuntimeRequest` for a long-lived streamed RPC. There is no
// persistent "connection" object to hold open across unrelated calls — every
// request carries the full `PairedCredential` and handshakes on its own. So
// connect()/disconnect() here are a thin credential holder plus bookkeeping
// to close any live subscriptions, not a real socket lifecycle.
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
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

function unwrapResponse<T>(response: RuntimeRpcResponse<T>): T {
	if (!response.ok) {
		throw new OrcaRemoteError(response.error.message, response.error);
	}
	return response.result;
}

// ─── session.tabs.* ──────────────────────────────────────────────────────
// `RuntimeMobileSessionAgentTab` from Orca's
// src/shared/runtime-mobile-session-tab-contracts.ts. NOTE: it carries no
// worktreePath/handle/agentIdentity field — nothing here directly correlates
// to the CLI-based OrcaTerminal list in orca-cli.ts. The closest thing is the
// `worktree` selector the *request* takes (see below), not a field on the tab
// itself.
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

export class OrcaRemoteClient {
	private credential: PairedCredential | null = null;
	private readonly openSubscriptions = new Set<RemoteRuntimeSubscription>();

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
}
