import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import nacl from "tweetnacl";
import { generateKeyPair, publicKeyToBase64 } from "../../src/orca-remote/e2ee-crypto";
import { acceptOrcaConnection, type ServerConnection } from "./e2ee-server-connection";
import type { PairingOffer } from "../../src/orca-remote/pairing";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
} from "../../src/orca-remote/protocol-version";
import type {
	AgentSessionTab,
	AgentSessionHistoryPage,
	AgentSessionSubscribeEvent,
	AgentJournalRenderItem,
	NativeChatRole,
	AgentJournalPromptOption,
} from "../../src/orca-remote-client";

export function historyPage(sessionId: string, items: AgentJournalRenderItem[], fence = 1): AgentSessionHistoryPage {
	return {
		sessionId,
		epoch: "e2e",
		fence,
		direction: "tail",
		items,
		removedItemIds: [],
		submissions: [],
		window: { oldest: null, newest: null, nextCursor: { epoch: "e2e", sequence: items.length } },
		hasOlder: false,
		hasNewer: false,
	};
}

export function textMessageItem(itemId: string, sequence: number, role: NativeChatRole, text: string): AgentJournalRenderItem {
	return {
		itemId,
		revision: 1,
		sequence,
		observedAt: Date.now(),
		body: { kind: "message", role, blocks: [{ type: "text", text }] },
	};
}

export function approvalItem(
	itemId: string,
	sequence: number,
	title: string,
	options: AgentJournalPromptOption[],
): AgentJournalRenderItem {
	return {
		itemId,
		revision: 1,
		sequence,
		observedAt: Date.now(),
		body: {
			kind: "approval",
			title,
			detail: null,
			options,
			resolution: { state: "pending", selectedOptionId: null, resolvedBy: null, resolvedAt: null },
		},
	};
}

export function agentSessionTab(sessionId: string, title: string, agent: "claude" | "codex" = "claude"): AgentSessionTab {
	return { type: "agent-session", id: sessionId, title, sessionId, agent, isActive: true };
}

// Orca's projectSessionTabAgentStatus for a paired runtime client (session-tab-agent-status-
// projection.ts): without the structured capability every agent-session tab is hidden; with it, a
// Claude (any non-Codex) tab is still hidden unless the Claude capability is advertised too. A fake
// that skipped this let the plugin ship without the Claude capability — every Claude chat then
// vanished from its own liveness check against a real Orca.
export function visibleSessionTabs(tabs: AgentSessionTab[], clientCapabilities: readonly string[]): AgentSessionTab[] {
	const structured = clientCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY);
	const claude = clientCapabilities.includes(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY);
	return tabs.filter((tab) => {
		if (tab.type !== "agent-session") return true;
		if (!structured) return false;
		return tab.agent === "codex" || claude;
	});
}

function minimalSubmission(clientMessageId: string) {
	return {
		clientMessageId,
		fence: 1,
		payloadFingerprint: "",
		dispatchState: "accepted" as const,
		providerItemId: null,
		reason: null,
		submittedAt: Date.now(),
		resolvedAt: null,
	};
}

// How the fake answers GET /single-session-index.html — the page Orca's single-session embed loads.
// "missing": 404 with an empty body, exactly what Orca's static handler returned before the page was
// part of the desktop build. "drop": the connection closes with no response (a network-level load
// failure). { html }: a 200 page, standing in for a working Orca build.
export type EmbedPageMode = "missing" | "drop" | { html: string };
export type LostReplyMode = "silent" | "drop";

export type FakeRepo = { id: string; path: string; kind?: "git" | "folder"; displayName?: string };
export type FakeWorkspace = { id: string; path: string };

interface Subscription {
	conn: ServerConnection;
	requestId: string;
	sessionId: string;
}

export class FakeOrcaServer {
	private readonly http: Server;
	private readonly wss: WebSocketServer;
	private readonly keyPair: nacl.BoxKeyPair;
	private embedPage: EmbedPageMode = "missing";
	private tabs: AgentSessionTab[] = [];
	private historyBySession = new Map<string, AgentSessionHistoryPage>();
	private subscriptions: Subscription[] = [];
	private receivedCalls = new Map<string, unknown[]>();
	private receivedCapabilityLists = new Map<string, (readonly string[])[]>();
	private resolveSubscription: (() => void) | null = null;
	private repos: FakeRepo[] = [];
	private workspacesByRepo = new Map<string, FakeWorkspace[]>();
	private createRefusal: { code: string; message: string } | null = null;
	// Committed creates by clientOperationId, so a replay of the same operation is answered as Orca's
	// operation ledger answers it (replayed: true) instead of creating a second session.
	private createdOperations = new Map<string, { sessionId: string; payloadFingerprint: string }>();
	private lostCreateReplies: { remaining: number; mode: LostReplyMode; commit: boolean } | null = null;

	private constructor(http: Server, wss: WebSocketServer, keyPair: nacl.BoxKeyPair) {
		this.http = http;
		this.wss = wss;
		this.keyPair = keyPair;
	}

	static async start(): Promise<FakeOrcaServer> {
		const keyPair = generateKeyPair();
		// Same origin for RPC and the embed page, as in real Orca: the plugin derives the embed's
		// http:// origin from the pairing's ws:// endpoint.
		const http = createServer();
		const wss = new WebSocketServer({ server: http });
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const server = new FakeOrcaServer(http, wss, keyPair);
		http.on("request", (req, res) => server.handleHttp(req, res));
		wss.on("connection", (ws) => server.handleConnection(ws));
		return server;
	}

	get port(): number {
		const address = this.http.address();
		if (typeof address === "string" || address === null) throw new Error("FakeOrcaServer has no port");
		return address.port;
	}

	get credential(): PairingOffer {
		return {
			v: 2,
			endpoint: `ws://127.0.0.1:${this.port}`,
			deviceToken: "fake-e2e-device-token",
			publicKeyB64: publicKeyToBase64(this.keyPair.publicKey),
			scope: "runtime",
		};
	}

	setSessionTabs(tabs: AgentSessionTab[]): void {
		this.tabs = tabs;
	}

	setRepos(repos: FakeRepo[]): void {
		this.repos = [...repos];
	}

	setWorkspaces(repoId: string, workspaces: FakeWorkspace[]): void {
		this.workspacesByRepo.set(repoId, [...workspaces]);
	}

	// Non-null: agentSession.create answers with this refusal (a mutation result with ok:false)
	// instead of creating a session.
	setCreateRefusal(refusal: { code: string; message: string } | null): void {
		this.createRefusal = refusal;
	}

	// The next `count` agentSession.create calls lose their reply: "silent" never answers (the client
	// times out), "drop" closes the socket (a transport error). With `commit` (the default) the create
	// still happens, as when Orca finishes a create whose reply never reaches the client.
	loseCreateReplies(count: number, mode: LostReplyMode, { commit = true }: { commit?: boolean } = {}): void {
		this.lostCreateReplies = count > 0 ? { remaining: count, mode, commit } : null;
	}

	setEmbedPage(mode: EmbedPageMode): void {
		this.embedPage = mode;
	}

	setSessionHistory(sessionId: string, page: AgentSessionHistoryPage): void {
		this.historyBySession.set(sessionId, page);
	}

	async waitForSubscription(sessionId: string): Promise<void> {
		while (true) {
			if (this.subscriptions.some((sub) => sub.sessionId === sessionId)) {
				return;
			}
			await new Promise<void>((resolve) => {
				const oldResolve = this.resolveSubscription;
				this.resolveSubscription = () => {
					oldResolve?.();
					resolve();
				};
			});
		}
	}

	pushHistoryEvent(sessionId: string, event: AgentSessionSubscribeEvent): void {
		for (const sub of this.subscriptions) {
			if (sub.sessionId !== sessionId) continue;
			sub.conn.sendEncrypted({ id: sub.requestId, ok: true, result: event, _meta: { runtimeId: "fake-orca" } });
		}
	}

	received(method: string): unknown[] {
		return this.receivedCalls.get(method) ?? [];
	}

	// The capability list the client advertised on each call to `method`, in call order.
	receivedCapabilities(method: string): (readonly string[])[] {
		return this.receivedCapabilityLists.get(method) ?? [];
	}

	async stop(): Promise<void> {
		for (const client of this.wss.clients) client.terminate();
		await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
		this.http.closeAllConnections();
		await new Promise<void>((resolve, reject) => this.http.close((err) => (err ? reject(err) : resolve())));
	}

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname !== "/single-session-index.html") {
			res.writeHead(404).end();
			return;
		}
		const mode = this.embedPage;
		if (mode === "drop") {
			req.socket.destroy();
			return;
		}
		if (mode === "missing") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(mode.html);
	}

	private handleConnection(ws: WebSocket): void {
		acceptOrcaConnection(ws, this.keyPair, (conn, request) => {
			const method = String(request.method);
			const calls = this.receivedCalls.get(method) ?? [];
			calls.push(request.params);
			this.receivedCalls.set(method, calls);
			const capabilityLists = this.receivedCapabilityLists.get(method) ?? [];
			capabilityLists.push([...conn.clientCapabilities]);
			this.receivedCapabilityLists.set(method, capabilityLists);
			this.handleRpc(conn, request);
		});
	}

	private handleRpc(conn: ServerConnection, request: Record<string, unknown>): void {
		const id = String(request.id);
		const method = String(request.method);
		const params = (request.params ?? {}) as Record<string, unknown>;
		const reply = (result: unknown) => conn.sendEncrypted({ id, ok: true, result, _meta: { runtimeId: "fake-orca" } });
		const fail = (code: string, message: string) => conn.sendEncrypted({ id, ok: false, error: { code, message } });

		switch (method) {
			case "session.tabs.listAll":
				reply({ snapshots: [{ worktree: "", tabs: visibleSessionTabs(this.tabs, conn.clientCapabilities) }] });
				return;
			case "repo.list":
				reply({ repos: this.repos });
				return;
			case "repo.add": {
				// Like Orca: adding a path that is already a project returns that project; adding a folder
				// project also gives it its one workspace (the folder itself).
				const path = String(params.path);
				const existing = this.repos.find((r) => r.path === path);
				if (existing) {
					reply({ repo: existing });
					return;
				}
				const repo: FakeRepo = {
					id: "repo-added",
					path,
					kind: "folder",
					displayName: typeof params.displayName === "string" ? params.displayName : undefined,
				};
				this.repos.push(repo);
				this.workspacesByRepo.set(repo.id, [{ id: "ws-added", path: repo.path }]);
				reply({ repo });
				return;
			}
			case "worktree.list": {
				const selector = String(params.repo ?? "");
				const repoId = selector.startsWith("id:") ? selector.slice(3) : selector;
				const worktrees = this.workspacesByRepo.get(repoId) ?? [];
				reply({ worktrees, totalCount: worktrees.length, truncated: false });
				return;
			}
			case "agentSession.create": {
				// Like Orca's requireStructuredCapability: without it, the structured session surface
				// doesn't exist for this client.
				if (!conn.clientCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
					fail("structured_agent_session_unsupported", "structured_agent_session_unsupported");
					return;
				}
				if (this.createRefusal) {
					reply({ ok: false, refusal: this.createRefusal });
					return;
				}
				const envelope = (params.envelope ?? {}) as {
					sessionId?: unknown;
					clientOperationId?: unknown;
					expectedRuntimeFence?: unknown;
					payloadFingerprint?: unknown;
				};
				// Like Orca: create is the one mutation that must not fence.
				if (envelope.expectedRuntimeFence !== null) {
					fail("agent_session_operation_invalid", "agent_session_operation_invalid");
					return;
				}
				const sessionId = String(envelope.sessionId);
				const operationId = String(envelope.clientOperationId);
				const fingerprint = String(envelope.payloadFingerprint);
				const answer = (replayed: boolean) =>
					reply({
						ok: true,
						replayed,
						fence: 1,
						cursor: { epoch: "e2e", sequence: 0 },
						value: { sessionId, fence: 1, page: historyPage(sessionId, []), unconfirmedClientMessageIds: [] },
					});
				const lost = this.lostCreateReplies;
				if (lost) {
					lost.remaining--;
					if (lost.remaining <= 0) this.lostCreateReplies = null;
				}
				const committed = this.createdOperations.get(operationId);
				if (committed) {
					if (committed.sessionId !== sessionId || committed.payloadFingerprint !== fingerprint) {
						reply({ ok: false, refusal: { code: "agent_session_operation_conflict", message: "operation id reused" } });
					} else if (!lost) {
						answer(true);
					} else if (lost.mode === "drop") {
						conn.terminate();
					}
					return;
				}
				if (!lost || lost.commit) {
					this.createdOperations.set(operationId, { sessionId, payloadFingerprint: fingerprint });
					this.tabs = [...this.tabs, agentSessionTab(sessionId, "New chat")];
				}
				if (!lost) answer(false);
				else if (lost.mode === "drop") conn.terminate();
				return;
			}
			case "agentSession.history": {
				const sessionId = String(params.sessionId);
				const page = this.historyBySession.get(sessionId) ?? historyPage(sessionId, []);
				reply({ ok: true, page });
				return;
			}
			case "agentSession.subscribe": {
				const sessionId = String(params.sessionId);
				this.subscriptions.push({ conn, requestId: id, sessionId });
				this.resolveSubscription?.();
				return;
			}
			case "agentSession.send":
				reply({
					ok: true,
					replayed: false,
					fence: 1,
					cursor: { epoch: "e2e", sequence: 1 },
					value: { clientMessageId: id, submission: minimalSubmission(id) },
				});
				return;
			case "agentSession.respondToApproval":
			case "agentSession.respondToQuestion":
				reply({ ok: true, replayed: false, fence: 1, cursor: { epoch: "e2e", sequence: 1 }, value: null });
				return;
			default:
				fail("unknown_method", `Fake Orca server has no handler for ${method}`);
		}
	}
}
