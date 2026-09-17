import { WebSocketServer, type WebSocket } from "ws";
import nacl from "tweetnacl";
import { generateKeyPair, publicKeyToBase64 } from "../../src/orca-remote/e2ee-crypto";
import { acceptOrcaConnection, type ServerConnection } from "./e2ee-server-connection";
import type { PairingOffer } from "../../src/orca-remote/pairing";
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

interface Subscription {
	conn: ServerConnection;
	requestId: string;
	sessionId: string;
}

export class FakeOrcaServer {
	private readonly wss: WebSocketServer;
	private readonly keyPair: nacl.BoxKeyPair;
	private tabs: AgentSessionTab[] = [];
	private historyBySession = new Map<string, AgentSessionHistoryPage>();
	private subscriptions: Subscription[] = [];
	private receivedCalls = new Map<string, unknown[]>();
	private subscriptionReady: Promise<void> | null = null;
	private resolveSubscription: (() => void) | null = null;

	private constructor(wss: WebSocketServer, keyPair: nacl.BoxKeyPair) {
		this.wss = wss;
		this.keyPair = keyPair;
	}

	static async start(): Promise<FakeOrcaServer> {
		const keyPair = generateKeyPair();
		const wss = new WebSocketServer({ port: 0 });
		await new Promise<void>((resolve) => wss.once("listening", resolve));
		const server = new FakeOrcaServer(wss, keyPair);
		wss.on("connection", (ws) => server.handleConnection(ws));
		return server;
	}

	get port(): number {
		const address = this.wss.address();
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

	async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
	}

	private handleConnection(ws: WebSocket): void {
		acceptOrcaConnection(ws, this.keyPair, (conn, request) => {
			const method = String(request.method);
			const calls = this.receivedCalls.get(method) ?? [];
			calls.push(request.params);
			this.receivedCalls.set(method, calls);
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
				reply({ snapshots: [{ worktree: "", tabs: this.tabs }] });
				return;
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
