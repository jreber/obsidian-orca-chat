# New-session button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Orca Chat pane's existing-session dropdown with a **New session** button that creates a Claude chat rooted at the Obsidian vault root, as a normal Orca session.

**Architecture:** The plugin registers the vault as a `folder` Orca project (after a one-time confirmation), finds its workspace id, and calls `agentSession.create` (`worktree: 'id:<workspaceId>'`). The session id is stored in the vault's `data.json` and re-mounted on open. One Orca-side change makes structured Claude sessions honor `agentCmdOverrides.claude`.

**Tech Stack:** Obsidian plugin (TypeScript, esbuild, node:test unit tests, Playwright e2e driving real Obsidian); Orca (Electron, TypeScript, vitest, Playwright e2e).

**Spec:** `docs/superpowers/specs/2026-09-23-new-session-button-design.md`

## Global Constraints

- Two worktrees, never the main checkouts: plugin `~/repos/obsidian-orca-chat/.worktrees/webview-didfail-status` (branch `webview-didfail-status`), Orca `~/repos/orca/.worktrees/agent-dashboard-webview-fixes` (branch `agent-dashboard-webview-fixes`). Absolute paths in commands. Commit per task; never push to main; push feature branches at the end only.
- Claude only. No Codex/Copilot/OpenCode UI.
- Cross-platform: no hardcoded path separators (`path.join`), no `metaKey` assumptions, no case-folding of paths, do not assume a workspace is a git repo (the vault is a `folder` project).
- Do not disturb the user's running Orca (pid via `pgrep -af orca`, `~/.config/orca-dev`) or running flatpak Obsidian. E2E uses isolated user-data dirs and only stops processes it started (flatpak: only its own instance id, never `flatpak kill md.obsidian.Obsidian`).
- Never use force/`--force` worktree removal. Before any destructive git/worktree operation run `git status` and `git diff --cached`.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015qY4SMxE9eyRd99wdqdvHF`
- Orca RPC wire changes: none (all calls already exist). Plugin uses existing `repo.list`, `repo.add`, `worktree.list`, `agentSession.create`, `session.tabs.listAll`.
- Orca lint: `oxlint`/`oxfmt --check` must be run per file (multi-file invocations misbehave in worktrees). Orca typecheck: `pnpm tc:node`. Plugin: `npm test` and `npm run build`.

## File Structure

Orca (`~/repos/orca/.worktrees/agent-dashboard-webview-fixes`):
- Create `src/main/claude/claude-command-override.ts` — pure `resolveClaudeCommandOverride`.
- Create `src/main/claude/claude-command-override.test.ts`.
- Modify `src/main/runtime/orca-runtime-get-worktree-ps.ts` (~line 155) — wire override into `installStructuredAgentSessionHost`.
- Create `tests/e2e/structured-folder-session.spec.ts` — Orca Playwright.

Plugin (`~/repos/obsidian-orca-chat/.worktrees/webview-didfail-status`):
- Create `src/vault-project.ts` — `normalizeVaultPath`, `findVaultRepo`.
- Create `src/new-session.ts` — `createVaultSession` orchestration.
- Create `src/vault-path.ts` — `getVaultRootPath(app)`.
- Create `src/add-project-modal.ts` — `confirmAddVaultProject`.
- Modify `src/orca-remote-client.ts` — `listRepos`, `addFolderRepo`, `listWorkspaces`, `createClaudeSession`.
- Modify `src/orca-pairing.ts` — `loadLastSessionId`, `saveLastSessionId`.
- Modify `src/chat-view.ts` — button, restore, existence check; drop dropdown/polling.
- Modify `src/main.ts` — `ensureChatViewReady` no longer calls `focusPicker`.
- Modify `test/fakes/obsidian.ts` — add `FileSystemAdapter`.
- Modify `test-e2e/protocol/fake-orca-server.ts` — repo/worktree/create handlers.
- Modify `test-e2e/chat-pane.spec.ts`, `test-e2e/embed-load-status.spec.ts` — click New session instead of the dropdown.
- Create `test-e2e/new-session.spec.ts`; create `test-e2e/real-orca.spec.ts` (combined).
- Tests: `test/vault-project.test.ts`, `test/new-session.test.ts`, `test/orca-remote-client-create.test.ts`, `test/last-session.test.ts`, `test/chat-view.test.ts` (extend).

---

## Task 1: Orca — structured Claude honors `agentCmdOverrides.claude`

**Files:**
- Create: `src/main/claude/claude-command-override.ts`, `src/main/claude/claude-command-override.test.ts`
- Modify: `src/main/runtime/orca-runtime-get-worktree-ps.ts` (inside `ensureStructuredAgentSessionHost`, add `resolveClaudeCommand`)

**Interfaces:**
- Produces: `resolveClaudeCommandOverride(override: string | undefined, homePath?: string): string | null` and `resolveStructuredClaudeCommand(override: string | undefined, fallback: () => string): string`.

- [ ] **Step 1: Write the failing test** `src/main/claude/claude-command-override.test.ts`

```ts
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveClaudeCommandOverride,
  resolveStructuredClaudeCommand
} from './claude-command-override'

describe('resolveClaudeCommandOverride', () => {
  it('returns null when unset, empty, or whitespace', () => {
    expect(resolveClaudeCommandOverride(undefined)).toBeNull()
    expect(resolveClaudeCommandOverride('')).toBeNull()
    expect(resolveClaudeCommandOverride('   ')).toBeNull()
  })

  it('trims and returns absolute paths unchanged', () => {
    expect(resolveClaudeCommandOverride('  /opt/bin/claude  ')).toBe('/opt/bin/claude')
  })

  it('expands a leading ~ using the home path', () => {
    const home = join('/home', 'tester')
    expect(resolveClaudeCommandOverride('~/bin/local-claude', home)).toBe(
      join(home, 'bin', 'local-claude')
    )
    expect(resolveClaudeCommandOverride('~', home)).toBe(home)
  })

  it('does not expand ~ in the middle of a value or ~user forms', () => {
    expect(resolveClaudeCommandOverride('/x/~/y', '/home/t')).toBe('/x/~/y')
    expect(resolveClaudeCommandOverride('~other/bin/c', '/home/t')).toBe('~other/bin/c')
  })

  it('passes a bare command name through for PATH lookup', () => {
    expect(resolveClaudeCommandOverride('local-claude')).toBe('local-claude')
  })
})

describe('resolveStructuredClaudeCommand', () => {
  it('uses the override when set and the fallback otherwise', () => {
    expect(resolveStructuredClaudeCommand('/o/claude', () => 'fallback')).toBe('/o/claude')
    expect(resolveStructuredClaudeCommand(undefined, () => 'fallback')).toBe('fallback')
    expect(resolveStructuredClaudeCommand('  ', () => 'fallback')).toBe('fallback')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/repos/orca/.worktrees/agent-dashboard-webview-fixes && npx vitest run --config config/vitest.config.ts src/main/claude/claude-command-override.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/main/claude/claude-command-override.ts`

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The user's configured `agentCmdOverrides.claude`, normalized; null when there is none. */
export function resolveClaudeCommandOverride(
  override: string | undefined,
  homePath: string = homedir()
): string | null {
  const trimmed = override?.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed === '~') {
    return homePath
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homePath, trimmed.slice(2))
  }
  return trimmed
}

export function resolveStructuredClaudeCommand(
  override: string | undefined,
  fallback: () => string
): string {
  return resolveClaudeCommandOverride(override) ?? fallback()
}
```

- [ ] **Step 4: Run to verify it passes** (same command). Expected: PASS.

- [ ] **Step 5: Wire it in.** In `src/main/runtime/orca-runtime-get-worktree-ps.ts`, inside the `installStructuredAgentSessionHost({ ... })` argument object, next to `resolveClaudeLaunchEnv`, add:

```ts
      // Chat sessions used a bare PATH lookup and ignored the per-agent command override that
      // terminal launches honor; re-read per launch like the neighbouring settings.
      resolveClaudeCommand: () =>
        resolveStructuredClaudeCommand(
          this.requireStore().getSettings().agentCmdOverrides?.claude,
          resolveClaudeCommand
        ),
```

with imports `import { resolveStructuredClaudeCommand } from '../claude/claude-command-override'` and `import { resolveClaudeCommand } from '../codex-cli/command'`.

- [ ] **Step 6: Verify:** `pnpm tc:node` (no errors); `npx oxlint --format=default <file>` and `npx oxfmt --check <file>` for each of the 3 files (run `npx oxfmt <file>` to fix); `npx vitest run --config config/vitest.config.ts src/main/runtime src/main/claude` (all pass).

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/claude-command-override.ts src/main/claude/claude-command-override.test.ts src/main/runtime/orca-runtime-get-worktree-ps.ts
git commit -m "feat(claude): structured chat sessions honor agentCmdOverrides.claude"
```
(with the trailers from Global Constraints)

---

## Task 2: Plugin — vault path matching

**Files:**
- Create: `src/vault-project.ts`, `test/vault-project.test.ts`

**Interfaces:**
- Produces: `normalizeVaultPath(p: string): string`; `type OrcaRepoSummary = { id: string; path: string; kind?: "git" | "folder"; displayName?: string }`; `findVaultRepo(repos: OrcaRepoSummary[], vaultPath: string): OrcaRepoSummary | null`.

- [ ] **Step 1: Failing test** `test/vault-project.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { findVaultRepo, normalizeVaultPath } from "../src/vault-project.ts";

test("normalizeVaultPath applies NFC and trims trailing slashes but keeps case", () => {
	assert.equal(normalizeVaultPath("/Users/x/Vault/"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/Users/x/Vault///"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/Users/x/Vault"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/u/cafe\u0301"), "/u/caf\u00e9");
	assert.notEqual(normalizeVaultPath("/Users/x/Vault"), normalizeVaultPath("/users/x/vault"));
});

test("normalizeVaultPath treats backslashes as separators for Windows paths", () => {
	assert.equal(normalizeVaultPath("C:\\Users\\x\\Vault\\"), "C:\\Users\\x\\Vault");
});

test("normalizeVaultPath keeps a filesystem root intact", () => {
	assert.equal(normalizeVaultPath("/"), "/");
});

test("findVaultRepo matches by normalized path across kinds", () => {
	const repos = [
		{ id: "r1", path: "/a/other", kind: "git" as const },
		{ id: "r2", path: "/Users/x/Vault/", kind: "folder" as const },
	];
	assert.equal(findVaultRepo(repos, "/Users/x/Vault")?.id, "r2");
	assert.equal(findVaultRepo(repos, "/nope"), null);
	assert.equal(findVaultRepo([], "/Users/x/Vault"), null);
});
```

- [ ] **Step 2: Run** `cd ~/repos/obsidian-orca-chat/.worktrees/webview-didfail-status && npm test 2>&1 | grep -E "^# (pass|fail)|not ok"` — Expected: failure (module missing).

- [ ] **Step 3: Implement** `src/vault-project.ts`

```ts
export type OrcaRepoSummary = {
	id: string;
	path: string;
	kind?: "git" | "folder";
	displayName?: string;
};

// Mirrors how Orca compares repo paths: Unicode NFC, collapsed trailing separators, exact case,
// no symlink resolution. Deliberately NOT case-folded (Orca does not either), so on a
// case-insensitive filesystem a differently-cased vault path registers as a second project.
export function normalizeVaultPath(p: string): string {
	const nfc = p.normalize("NFC");
	const trimmed = nfc.replace(/[\\/]+$/, "");
	return trimmed === "" ? nfc.slice(0, 1) : trimmed;
}

export function findVaultRepo(repos: OrcaRepoSummary[], vaultPath: string): OrcaRepoSummary | null {
	const wanted = normalizeVaultPath(vaultPath);
	return repos.find((repo) => normalizeVaultPath(repo.path) === wanted) ?? null;
}
```

- [ ] **Step 4: Run tests** — Expected: all pass.
- [ ] **Step 5: Commit** `git add src/vault-project.ts test/vault-project.test.ts && git commit -m "feat: vault path normalization and project lookup"` (+ trailers).

---

## Task 3: Plugin — remote client calls for repos, workspaces, create

**Files:**
- Modify: `src/orca-remote-client.ts` (add methods in the `OrcaRemoteClient` class after `listAllAgentSessionTabs`)
- Test: `test/orca-remote-client-create.test.ts`

**Interfaces:**
- Consumes: `OrcaRepoSummary` (Task 2), existing `sendRemoteRuntimeRequest`, `unwrapResponse`, `toOrcaRemoteError`, `computeAgentSessionPayloadFingerprint`, `STRUCTURED_AGENT_SESSION_CAPABILITIES`, `DEFAULT_REQUEST_TIMEOUT_MS`.
- Produces on `OrcaRemoteClient`:
  - `listRepos(): Promise<OrcaRepoSummary[]>`
  - `addFolderRepo(path: string, displayName: string): Promise<OrcaRepoSummary>`
  - `listWorkspaces(repoId: string): Promise<{ id: string; path: string }[]>`
  - `createClaudeSession(workspaceId: string): Promise<{ sessionId: string }>`
- Also export `buildCreateEnvelope(sessionId: string, worktree: string, agent: "claude"): AgentSessionMutationEnvelope` (pure; used by tests).

- [ ] **Step 1: Failing test** `test/orca-remote-client-create.test.ts`

```ts
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
```

(First locate where the plugin's vendored `computeAgentSessionPayloadFingerprint` lives with `grep -rn "export function computeAgentSessionPayloadFingerprint" src` and fix the import path in the test accordingly.)

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (`buildCreateEnvelope` not exported).

- [ ] **Step 3: Implement.** Add near `buildMutationEnvelope`'s helper section (module level, exported):

```ts
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
```

Add to the class (all wrap errors with `toOrcaRemoteError`, use `DEFAULT_REQUEST_TIMEOUT_MS` and pass `STRUCTURED_AGENT_SESSION_CAPABILITIES` as the last argument for `agentSession.create` like the other agentSession calls):

```ts
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

	async createClaudeSession(workspaceId: string): Promise<{ sessionId: string }> {
		const credential = this.requireCredential();
		const sessionId = crypto.randomUUID();
		const worktree = `id:${workspaceId}`;
		try {
			const response = await sendRemoteRuntimeRequest<AgentSessionMutationResult<{ sessionId: string }>>(
				credential,
				"agentSession.create",
				{ envelope: buildCreateEnvelope(sessionId, worktree, "claude"), worktree, agent: "claude" },
				DEFAULT_REQUEST_TIMEOUT_MS,
				undefined,
				undefined,
				STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			const result = unwrapResponse(response);
			if (!result.ok) {
				throw new OrcaRemoteError(`agentSession.create refused (${result.refusal.code}): ${result.refusal.message}`, result.refusal);
			}
			return { sessionId: result.value.sessionId };
		} catch (err) {
			throw toOrcaRemoteError(err);
		}
	}
```

Also `import type { OrcaRepoSummary } from "./vault-project";`. NOTE: the real session-id format Orca accepts for create is unverified; if the combined e2e (Task 11) shows a refusal such as `agent_session_operation_invalid`, adjust `sessionId` to the format Orca's renderer uses (grep Orca's `use-structured-agent-session-create` for its id generator) and add a test pinning it.

- [ ] **Step 4: Run** `npm test && npm run build` — Expected: pass.
- [ ] **Step 5: Commit** `git add src/orca-remote-client.ts test/orca-remote-client-create.test.ts && git commit -m "feat(client): repo/worktree/create calls for vault sessions"` (+ trailers).

---

## Task 4: Plugin — last-session persistence

**Files:** Modify `src/orca-pairing.ts`; Test `test/last-session.test.ts`.

**Interfaces:** Produces `loadLastSessionId(plugin: Plugin): Promise<string | null>`, `saveLastSessionId(plugin: Plugin, sessionId: string | null): Promise<void>`. Both read-modify-write the whole `data.json` blob (keeps `pairedCredential`).

- [ ] **Step 1: Failing test** `test/last-session.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { App, Plugin } from "./fakes/obsidian.ts";
import { loadLastSessionId, loadPairedCredential, saveLastSessionId, savePairedCredential } from "../src/orca-pairing.ts";

function makePlugin() {
	const plugin = new Plugin(new App());
	let blob: unknown = null;
	plugin.loadData = async () => blob;
	plugin.saveData = async (data: unknown) => {
		blob = data;
	};
	return plugin;
}

test("last session id round-trips and null clears it", async () => {
	const plugin = makePlugin();
	assert.equal(await loadLastSessionId(plugin), null);
	await saveLastSessionId(plugin, "sess-9");
	assert.equal(await loadLastSessionId(plugin), "sess-9");
	await saveLastSessionId(plugin, null);
	assert.equal(await loadLastSessionId(plugin), null);
});

test("saving the session id keeps the paired credential and vice versa", async () => {
	const plugin = makePlugin();
	const cred = { v: 2, endpoint: "ws://x", deviceToken: "t", publicKeyB64: "k", scope: "runtime" } as never;
	await savePairedCredential(plugin, cred);
	await saveLastSessionId(plugin, "s1");
	assert.deepEqual(await loadPairedCredential(plugin), cred);
	await savePairedCredential(plugin, cred);
	assert.equal(await loadLastSessionId(plugin), "s1");
});
```

(Check `test/fakes/obsidian.ts` `Plugin` — if `loadData`/`saveData` are already implemented with an in-memory blob, drop the overrides and use them.)

- [ ] **Step 2: Run** `npm test` — FAIL. 
- [ ] **Step 3: Implement.** In `src/orca-pairing.ts` extend the data interface and add:

```ts
interface OrcaChatPluginData {
	pairedCredential: PairedCredential | null;
	lastSessionId?: string | null;
}

export async function loadLastSessionId(plugin: Plugin): Promise<string | null> {
	return (await loadPluginData(plugin)).lastSessionId ?? null;
}

export async function saveLastSessionId(plugin: Plugin, sessionId: string | null): Promise<void> {
	const data = await loadPluginData(plugin);
	await plugin.saveData({ ...data, pairedCredential: data.pairedCredential ?? null, lastSessionId: sessionId });
}
```

Update `savePairedCredential` to spread `...data` (already does) so `lastSessionId` survives.

- [ ] **Step 4: Run** `npm test` — pass. **Step 5: Commit** `git add src/orca-pairing.ts test/last-session.test.ts && git commit -m "feat: persist the vault's last Orca session id"` (+ trailers).

---

## Task 5: Plugin — create-session orchestration

**Files:** Create `src/new-session.ts`, `test/new-session.test.ts`.

**Interfaces:**
- Consumes: `OrcaRepoSummary`, `findVaultRepo` (Task 2); client methods (Task 3) via this minimal interface:

```ts
export interface NewSessionClient {
	listRepos(): Promise<OrcaRepoSummary[]>;
	addFolderRepo(path: string, displayName: string): Promise<OrcaRepoSummary>;
	listWorkspaces(repoId: string): Promise<{ id: string; path: string }[]>;
	createClaudeSession(workspaceId: string): Promise<{ sessionId: string }>;
}
```
- Produces: `createVaultSession(args: { client: NewSessionClient; vaultPath: string; vaultName: string; confirmAddProject: () => Promise<boolean> }): Promise<{ sessionId: string }>`, and `class NewSessionCancelled extends Error` (user declined the add-project prompt) and `class NewSessionError extends Error` (message shown to the user).

- [ ] **Step 1: Failing test** `test/new-session.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createVaultSession, NewSessionCancelled, NewSessionError, type NewSessionClient } from "../src/new-session.ts";

function fakeClient(over: Partial<NewSessionClient> = {}, log: string[] = []): NewSessionClient {
	return {
		listRepos: async () => (log.push("listRepos"), [{ id: "r1", path: "/v", kind: "folder" as const }]),
		addFolderRepo: async (path, name) => (log.push(`add ${path} ${name}`), { id: "r2", path, kind: "folder" as const }),
		listWorkspaces: async (id) => (log.push(`workspaces ${id}`), [{ id: "ws-" + id, path: "/v" }]),
		createClaudeSession: async (ws) => (log.push(`create ${ws}`), { sessionId: "sess-1" }),
		...over,
	};
}
const args = (client: NewSessionClient, confirm = async () => true) => ({
	client, vaultPath: "/v/", vaultName: "My Vault", confirmAddProject: confirm,
});

test("registered vault: no prompt, no add, creates in its workspace", async () => {
	const log: string[] = [];
	let prompted = false;
	const out = await createVaultSession(args(fakeClient({}, log), async () => ((prompted = true), true)));
	assert.deepEqual(out, { sessionId: "sess-1" });
	assert.equal(prompted, false);
	assert.deepEqual(log, ["listRepos", "workspaces r1", "create ws-r1"]);
});

test("unregistered vault: asks once, adds as folder project, then creates", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => (log.push("listRepos"), []) }, log);
	const out = await createVaultSession(args(client));
	assert.equal(out.sessionId, "sess-1");
	assert.deepEqual(log, ["listRepos", "add /v/ My Vault", "workspaces r2", "create ws-r2"]);
});

test("declining the add-project prompt creates nothing", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => (log.push("listRepos"), []) }, log);
	await assert.rejects(createVaultSession(args(client, async () => false)), NewSessionCancelled);
	assert.deepEqual(log, ["listRepos"]);
});

test("a project with no workspace is a clear error and creates nothing", async () => {
	const log: string[] = [];
	const client = fakeClient({ listWorkspaces: async () => [] }, log);
	await assert.rejects(createVaultSession(args(client)), (e: unknown) => e instanceof NewSessionError && /workspace/i.test((e as Error).message));
	assert.ok(!log.some((l) => l.startsWith("create")));
});

test("prefers the workspace whose path is the vault root when several exist", async () => {
	const log: string[] = [];
	const client = fakeClient({
		listWorkspaces: async () => [{ id: "other", path: "/elsewhere" }, { id: "root", path: "/v" }],
	}, log);
	await createVaultSession(args(client));
	assert.ok(log.includes("create root"));
});

test("listRepos failure propagates and nothing is added or created", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => { throw new Error("offline"); } }, log);
	await assert.rejects(createVaultSession(args(client)), /offline/);
	assert.deepEqual(log, []);
});
```

- [ ] **Step 2: Run** `npm test` — FAIL.
- [ ] **Step 3: Implement** `src/new-session.ts`

```ts
import { findVaultRepo, normalizeVaultPath, type OrcaRepoSummary } from "./vault-project";

export interface NewSessionClient {
	listRepos(): Promise<OrcaRepoSummary[]>;
	addFolderRepo(path: string, displayName: string): Promise<OrcaRepoSummary>;
	listWorkspaces(repoId: string): Promise<{ id: string; path: string }[]>;
	createClaudeSession(workspaceId: string): Promise<{ sessionId: string }>;
}

export class NewSessionCancelled extends Error {
	constructor() {
		super("New session cancelled");
		this.name = "NewSessionCancelled";
	}
}

export class NewSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NewSessionError";
	}
}

export async function createVaultSession(args: {
	client: NewSessionClient;
	vaultPath: string;
	vaultName: string;
	confirmAddProject: () => Promise<boolean>;
}): Promise<{ sessionId: string }> {
	const { client, vaultPath } = args;
	let repo = findVaultRepo(await client.listRepos(), vaultPath);
	if (!repo) {
		if (!(await args.confirmAddProject())) throw new NewSessionCancelled();
		repo = await client.addFolderRepo(vaultPath, args.vaultName);
	}
	const workspaces = await client.listWorkspaces(repo.id);
	const wanted = normalizeVaultPath(vaultPath);
	const workspace = workspaces.find((w) => normalizeVaultPath(w.path) === wanted) ?? workspaces[0];
	if (!workspace) {
		throw new NewSessionError("Orca has no workspace for this vault — open the project in Orca once, then try again.");
	}
	return client.createClaudeSession(workspace.id);
}
```

- [ ] **Step 4: Run** `npm test` — pass. **Step 5: Commit** `git add src/new-session.ts test/new-session.test.ts && git commit -m "feat: vault-rooted session creation flow"` (+ trailers).

---

## Task 6: Plugin — confirmation modal and vault path helper

**Files:** Create `src/add-project-modal.ts`, `src/vault-path.ts`; Modify `test/fakes/obsidian.ts` (add `export class FileSystemAdapter { constructor(private base: string) {} getBasePath() { return this.base; } }`); Test in `test/vault-path.test.ts`.

**Interfaces:** Produces `getVaultRootPath(app: App): string | null` and `confirmAddVaultProject(app: App, vaultName: string, vaultPath: string): Promise<boolean>`.

- [ ] **Step 1: Failing test** `test/vault-path.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { App, FileSystemAdapter } from "./fakes/obsidian.ts";
import { getVaultRootPath } from "../src/vault-path.ts";

test("returns the base path on a desktop (filesystem) vault", () => {
	const app = new App();
	(app.vault as { adapter: unknown }).adapter = new FileSystemAdapter("/Users/x/Vault");
	assert.equal(getVaultRootPath(app), "/Users/x/Vault");
});

test("returns null when the vault has no filesystem adapter (mobile)", () => {
	const app = new App();
	(app.vault as { adapter: unknown }).adapter = {};
	assert.equal(getVaultRootPath(app), null);
});
```

(Adjust to the shape of the fake `App.vault` in `test/fakes/obsidian.ts`; add `vault: { adapter: unknown; getName(): string }` there if missing.)

- [ ] **Step 2: Run** `npm test` — FAIL. **Step 3: Implement**

`src/vault-path.ts`:
```ts
import { App, FileSystemAdapter } from "obsidian";

// getBasePath exists only on the desktop filesystem adapter; mobile vaults have no host path.
export function getVaultRootPath(app: App): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}
```

`src/add-project-modal.ts`:
```ts
import { App, Modal } from "obsidian";

class AddProjectModal extends Modal {
	private settled = false;
	constructor(app: App, private vaultName: string, private vaultPath: string, private done: (ok: boolean) => void) {
		super(app);
	}
	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Add this vault to Orca?" });
		contentEl.createEl("p", {
			text: `Orca Chat will add “${this.vaultName}” (${this.vaultPath}) to Orca as a project so chats can run in your vault. You'll only be asked once.`,
		});
		const row = contentEl.createDiv();
		const add = row.createEl("button", { text: "Add to Orca", cls: "mod-cta" });
		const cancel = row.createEl("button", { text: "Cancel" });
		add.onclick = () => this.finish(true);
		cancel.onclick = () => this.finish(false);
	}
	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}
	private finish(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(ok);
		this.close();
	}
}

export function confirmAddVaultProject(app: App, vaultName: string, vaultPath: string): Promise<boolean> {
	return new Promise((resolve) => new AddProjectModal(app, vaultName, vaultPath, resolve).open());
}
```

- [ ] **Step 4: Run** `npm test && npm run build` — pass. **Step 5: Commit** `git add src test && git commit -m "feat: add-project confirmation modal and vault root helper"` (+ trailers).

---

## Task 7: Plugin — chat pane: New session button, restore, existence check

**Files:** Modify `src/chat-view.ts`, `src/main.ts`; Extend `test/chat-view.test.ts`.

**Interfaces:**
- Consumes: `createVaultSession`, `NewSessionCancelled`, `NewSessionError` (Task 5); `getVaultRootPath`, `confirmAddVaultProject` (Task 6); `loadLastSessionId`, `saveLastSessionId` (Task 4); `OrcaRemoteClient.listAllAgentSessionTabs`.
- Produces on `OrcaChatView`: `getSelectedHandle(): string | null` (returns the current session id — name kept so `main.ts` and existing tests keep working), `focusNewSessionButton(): void` (replaces `focusPicker`), `sendToSelected(text)` unchanged in contract. DOM: button `.orca-chat-new-session`, status `.orca-chat-status-label`, embed `.orca-chat-embed`, webview `.orca-chat-webview` (unchanged classes except the dropdown `.orca-chat-session-select`, which is removed).

- [ ] **Step 1: Failing tests** appended to `test/chat-view.test.ts` (plain-DOM white-box, using the existing fakes; expose the two private methods needed through `as any`-free public seams: `restoreLastSession()` and `checkCurrentSession()` are made **public** for testing):

```ts
test("no stored session: shows the button state, mounts nothing", async () => {
	const view = makeView();
	await view.onOpen();
	view.setClientForTest({ listAllAgentSessionTabs: async () => [] });
	view.setStoredSessionIdForTest(null);
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.match(view.contentEl.querySelector(".orca-chat-status-label")!.textContent ?? "", /New session/);
});

test("stored session still in Orca: reattaches and mounts its webview", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({ listAllAgentSessionTabs: async () => [{ sessionId: "s1", agent: "claude", title: "t" }] });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), "s1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
});

test("stored session gone from Orca: clears it and says it ended", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({ listAllAgentSessionTabs: async () => [] });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.ok(FakeNoticeLog.some((m) => /ended/i.test(m)));
	assert.equal(view.getStoredSessionIdForTest(), null);
});

test("Orca unreachable at open keeps the stored id (does not forget the session)", async () => {
	const view = makeView();
	await view.onOpen();
	view.setClientForTest({ listAllAgentSessionTabs: async () => { throw new Error("offline"); } });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getStoredSessionIdForTest(), "s1");
});
```

Define `FAKE_CREDENTIAL` as `{ v: 2, endpoint: "ws://127.0.0.1:1", deviceToken: "t", publicKeyB64: "k", scope: "runtime" }`; import `FakeNoticeLog` from the obsidian fake. The `*ForTest` methods are thin setters documented as test seams (client, credential, in-memory stored id used instead of `plugin.loadData` when set).

- [ ] **Step 2: Run** `npm test` — FAIL.

- [ ] **Step 3: Implement.** Rewrite the class body of `src/chat-view.ts` (keep `interceptObsidianLinks`, `watchEmbedLoad`, constants, and the embed-mount code):
  - Fields: `newSessionButton`, `statusLabel`, `embedContainer`, `currentWebview`, `currentSessionId: string | null`, `credential`, `remoteClient`, `busy = false`. Remove `dropdown`, `entries`, `populateSessions`, `hasRemote`, the 3 s interval.
  - `onOpen`: build header row: `this.newSessionButton = headerRow.createEl("button", { text: "New session", cls: "mod-cta orca-chat-new-session" })` with `onclick = () => void this.onNewSession()`; `statusLabel`; `embedContainer`; `void this.initializeRemote()`; `this.registerInterval(window.setInterval(() => void this.checkCurrentSession(), 15_000))`.
  - `initializeRemote`: load credential (as today), connect, then `await this.restoreLastSession()`.
  - `restoreLastSession`: `id = await this.readStoredSessionId()`; if `!id` → `setStatus("No session — click New session")`, return. Try `tabs = await client.listAllAgentSessionTabs()` (catch → `reportError`, status "Can't reach Orca", **keep the stored id**, return). If `tabs` has `id` → `mountSession(id, tab.agent)`; else `writeStoredSessionId(null)`, `new Notice("Orca Chat: previous session ended — click New session")`, status "No session — click New session".
  - `onNewSession`: guard `busy`; `vaultPath = getVaultRootPath(this.app)` → if null Notice "Orca Chat needs desktop Obsidian" and return; if `!credential || !remoteClient` Notice "Not paired with Orca — see the Pair with Orca command" and return; `busy = true; button.disabled = true`; status "Creating session…"; call `createVaultSession({ client: this.remoteClient, vaultPath, vaultName: this.app.vault.getName(), confirmAddProject: () => confirmAddVaultProject(this.app, vaultName, vaultPath) })`; on success `await writeStoredSessionId(sessionId); mountSession(sessionId, "claude")`; catch `NewSessionCancelled` → status "No session — click New session" (no Notice); catch other → `reportError` (extend `reportError` so a `NewSessionError` shows its message) and status "⚠ Couldn't create a session"; finally re-enable.
  - `mountSession(sessionId, agent)`: the existing `updateEmbed` body from `teardownWebview()` onward, with `entry.sessionId`→`sessionId`, `entry.agent`→`agent`; set `this.currentSessionId = sessionId`. No-op if the same session is already mounted.
  - `checkCurrentSession` (public): if `!currentSessionId || !remoteClient` return; `tabs = await listAllAgentSessionTabs()` (swallow errors quietly — transient); if missing → `teardownWebview()`, `currentSessionId = null`, `writeStoredSessionId(null)`, Notice "Orca Chat: session ended — click New session", status "No session — click New session".
  - `getSelectedHandle()` returns `this.currentSessionId`; `focusNewSessionButton()` focuses the button; `sendToSelected` uses `currentSessionId` and, when null, `new Notice("Click New session in the Orca Chat pane first")`.
  - Test seams (`setClientForTest`, `setCredentialForTest`, `setStoredSessionIdForTest`, `getStoredSessionIdForTest`): when `storedSessionOverride !== undefined`, `readStoredSessionId/writeStoredSessionId` use it instead of `plugin.loadData/saveData`.
  - In `src/main.ts` `ensureChatViewReady`: replace `if (!chatView.getSelectedHandle()) { chatView.focusPicker(); }` with `chatView.focusNewSessionButton()` inside the same condition.
  - Update the existing status strings: keep "Connecting…", "● Live chat", "⚠ Chat failed to load"; remove "— pick a session —" options.

- [ ] **Step 4: Run** `npm test && npm run build` — all pass (also update any existing unit test that referenced `focusPicker` or the dropdown).
- [ ] **Step 5: Commit** `git add src test && git commit -m "feat(chat-view): New session button replaces the session picker"` (+ trailers).

---

## Task 8: Plugin e2e — fake server + updated specs + new-session specs

**Files:** Modify `test-e2e/protocol/fake-orca-server.ts`, `test-e2e/chat-pane.spec.ts`, `test-e2e/embed-load-status.spec.ts`; Create `test-e2e/new-session.spec.ts`.

**Interfaces:**
- Produces on `FakeOrcaServer`: `setRepos(repos: {id:string;path:string;kind?:"git"|"folder"}[])`, `setWorkspaces(repoId: string, ws: {id:string;path:string}[])`, `setCreateRefusal(refusal: {code:string;message:string} | null)`; handlers `repo.list` → `{repos}`, `repo.add` → records params, appends `{id: "repo-added", path, kind: "folder"}` to repos and auto-provisions workspace `{id: "ws-added", path}`, `worktree.list` → `{worktrees: [...], totalCount, truncated:false}`, `agentSession.create` → records params; unless a refusal is set, adds `agentSessionTab(params.envelope.sessionId, "New chat")` to tabs and replies `{ok:true,replayed:false,fence:1,cursor,value:{sessionId, fence:1, page: historyPage(sessionId, []), unconfirmedClientMessageIds: []}}`.
- The fixture vault path: expose `vaultPath` from `test-e2e/helpers/obsidian-fixture.ts` (the temp vault copy's absolute path) so specs can `server.setRepos([{ id: "r1", path: vaultPath, kind: "folder" }])`. Check how the fixture creates the vault and export it.

- [ ] **Step 1:** Update `selectSession` in both existing specs: register the vault + workspace on the server (or rely on `repo.add` auto-provision), click `.orca-chat-new-session`, then `await expect(obsidian.locator("webview.orca-chat-webview")).toBeAttached()`. Assertions on status/notices are unchanged.
- [ ] **Step 2: Write `test-e2e/new-session.spec.ts`** with these tests (each uses `server`, `obsidian`, and the fixture's `vaultPath`):
  1. **registered vault:** `server.setRepos([{id:"r1", path: vaultPath, kind:"folder"}])`, `setWorkspaces("r1",[{id:"ws1", path: vaultPath}])`; click New session; expect webview attached; `server.received("repo.add")` length 0; `server.received("agentSession.create")[0]` matches `{ worktree: "id:ws1", agent: "claude", envelope: { expectedRuntimeFence: null } }`.
  2. **unregistered + confirm:** no repos; click New session; the modal `.modal` with text "Add this vault to Orca?" appears; click "Add to Orca"; `repo.add` received once with `{ path: vaultPath, kind: "folder" }`; then create; webview attached.
  3. **unregistered + cancel:** click Cancel; no `repo.add`, no `agentSession.create`; no webview; status "No session — click New session".
  4. **reattach after reload:** create a session (test 1 setup); reload the Obsidian window (`obsidian.reload()` or close/reopen the pane via the command palette "Open Orca chat" after `workspace.detachLeavesOfType`); expect the webview re-mounted for the same session id **without** a second `agentSession.create` call.
  5. **session vanished:** after test 1 setup, `server.setSessionTabs([])`; within ~20 s (15 s check) the webview disappears, notice "session ended" shows, and reloading the pane shows the New session state.
  6. **create refused:** `server.setCreateRefusal({code:"agent_session_unsupported", message:"nope"})`; click; notice contains "nope"; status "⚠ Couldn't create a session"; nothing stored (reload → "No session").
  7. **not paired:** run without credential (use the fixture's option for no pairing, or clear `pairedCredential` via `obsidian.evaluate`); click; notice "Not paired with Orca".
- [ ] **Step 3: Run** `cd ~/repos/obsidian-orca-chat/.worktrees/webview-didfail-status && DISPLAY=:0 XAUTHORITY=$HOME/.xauthority ORCA_CHAT_E2E_SCREENSHOT_DIR=$HOME/.claude/jobs/baeec99b/tmp npx playwright test --workers=1` (use `~/.Xauthority` as previously; if `DISPLAY=:0` is unavailable, report it). Expected: all specs pass including the existing 4 updated ones. Screenshot the pane in states: initial (button), unregistered modal, live, ended.
- [ ] **Step 4: Verify safety:** confirm the user's Obsidian instances are untouched (`flatpak ps` before/after) and `~/.cache/orca-chat-e2e` is empty afterwards.
- [ ] **Step 5: Commit** `git add test-e2e && git commit -m "test(e2e): New session flows against the fake Orca server"` (+ trailers).

---

## Task 9: Orca e2e — real create in a non-git folder project + override honored

**Files:** Create `tests/e2e/structured-folder-session.spec.ts` (Orca worktree). Reuse the existing `tests/e2e/structured-session-embed-and-dashboard.spec.ts` helpers and `tests/e2e/fixtures/structured-claude-stub/` (extend the stub to record `argv[1]`/`$0` to a file named by env `CLAUDE_STUB_LOG` if it can; otherwise record via the stub's own path in its startup output).

- [ ] **Step 1:** Read `tests/e2e/AGENTS.md` and the existing spec to follow conventions (fixtures, `launchEnv`, max-lines).
- [ ] **Step 2: Write the spec** with two tests:
  1. **Folder project session:** in the e2e app, call `window.api.runtime.call('repo.add', { path: <fresh temp non-git dir>, kind: 'folder', displayName: 'Vault' })`, then `repo.list` (contains it), `worktree.list { repo: 'id:<repoId>' }` (yields a workspace with `path` = the dir), then `agentSession.create` via the same params builder the existing spec uses with `worktree: 'id:<workspaceId>'`. Assert the result is `ok`, the Agent Dashboard shows a "Claude Chat" card, and the card's workspace/folder label is the temp dir's name. Also assert `repo.add` twice returns the same repo id (idempotent).
  2. **Override honored:** create a second stub executable (a copy of the stub wrapper under a different name/path, e.g. `<tmp>/bin/my-claude`) that logs its own path to `CLAUDE_STUB_LOG` then execs the stub; set `settings.agentCmdOverrides.claude` to that path (via the app's settings update RPC/`window.api.settings.set` — find the right call), and to a `~/`-relative form using the isolated HOME, create a session, and assert the log contains the override path and NOT the PATH stub's default location. Negative control (local, not committed): revert Task 1's wiring line, rebuild with `pnpm exec electron-vite build --mode e2e`, confirm the test fails, restore (verify with `git diff`), rebuild, confirm it passes.
- [ ] **Step 3: Run** `VITE_EXPOSE_STORE=true pnpm exec electron-vite build --mode e2e && node config/scripts/project-renderer-web-client.mjs && ORCA_E2E_SCREENSHOT_DIR=$HOME/.claude/jobs/baeec99b/tmp/shots SKIP_BUILD=1 DISPLAY=:0 pnpm exec playwright test tests/e2e/structured-folder-session.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1` — Expected: pass; screenshot the dashboard card to `shots/e2e-folder-card.png`.
- [ ] **Step 4:** `npx oxlint --format=default <spec>` and `npx oxfmt --check <spec>`; `pnpm run check:max-lines-ratchet`.
- [ ] **Step 5: Commit** `git add tests/e2e && git commit -m "test(e2e): folder-project chat creation and Claude command override"` (+ trailers).

---

## Task 10: Combined e2e — real Obsidian paired to a real Orca

**Files:** Create `test-e2e/real-orca.spec.ts` in the plugin worktree, plus a small helper `test-e2e/helpers/real-orca.ts` that launches Orca.

**Goal:** prove the whole chain: click **New session** in a real Obsidian; the same session appears in the pane and on Orca's dashboard; and settle the open questions (client permission for `repo.add`/`worktree.list`; session-id format; `path:` fallback).

- [ ] **Step 1: Launch helper.** Start Orca from the Orca worktree with an isolated userData/HOME (mirror how `tests/e2e` launches Electron — see `tests/e2e/helpers` in the Orca worktree — via `playwright._electron.launch` with env: isolated `HOME`, `PATH` with the stub Claude first, e2e-mode build from Task 9), enable its runtime WebSocket server and obtain a pairing URL through the same RPC/IPC the app's "pair a device" UI uses (find it: grep Orca for `pairing` / `createPairingOffer`; the plugin's `decodePairingUrl` consumes the resulting URL). Return `{ pairingUrl, orcaPage, close() }`. Never touch `~/.config/orca-dev` or the user's running Orca; kill only the process this helper started.
- [ ] **Step 2: Spec.** Launch Orca; launch Obsidian via the existing fixture with `pairedCredential` decoded from the pairing URL (extend the fixture to accept a real credential instead of `FakeOrcaServer`'s); click **New session**; handle the add-project modal (vault not registered in the fresh Orca); assert: webview attached and status becomes "● Live chat"; in `orcaPage`, `repo.list` contains the vault dir, the Agent Dashboard shows the "Claude Chat" card with the seed message; the pane's webview shows the chat transcript (capture via `webview.capturePage()`); then click **New session** again and assert a second card appears; reload Obsidian and assert the pane reattaches to the second session. Screenshots to `~/.claude/jobs/baeec99b/tmp/combined-*.png`.
- [ ] **Step 3: Resolve unknowns.** If `repo.add`/`worktree.list` are refused for the plugin's client kind, or `agentSession.create` refuses the session-id format, fix the plugin (and, only if unavoidable, Orca's allowlist) and add a pinning unit test; record the finding in the spec's "Testing" section. If `path:<vault>` proves simpler than `worktree.list`, do **not** switch; keep the tested `id:` flow.
- [ ] **Step 4: Run** the combined spec; expected pass; verify the user's Orca and Obsidian were untouched (`pgrep`, `flatpak ps` before/after) and temp dirs cleaned.
- [ ] **Step 5: Commit** in the plugin worktree (`test(e2e): New session against a real Orca`) and, if Orca changed, in the Orca worktree.

---

## Task 11: Final verification, docs, push

- [ ] **Step 1:** Plugin: `npm test`, `npm run build`, full `npx playwright test --workers=1`. Orca: `pnpm tc:node`, per-file oxlint/oxfmt on every changed file, `pnpm run check:max-lines-ratchet`, `npx vitest run --config config/vitest.config.ts src/main/runtime src/main/claude config/scripts`, plus Task 9's Playwright spec. All must be green; report any pre-existing flaky failure by re-running it alone.
- [ ] **Step 2:** Update the spec's status line to "implemented; verified on Linux" and list what remains **untested on macOS** (default Obsidian binary path in the e2e fixture, real `~/bin/local-claude`, case-insensitive path collisions). Add a short "How to try on macOS" block (branch names, `git stash -u` warning, build/copy/reload steps, set Orca Settings → agent command override for Claude to `~/bin/local-claude`).
- [ ] **Step 3:** `git status`/`git diff --cached` in both worktrees (nothing unintended; `node_modules` symlink stays untracked). Push both branches to their existing remotes: Orca `git push personal agent-dashboard-webview-fixes`, plugin `git push origin webview-didfail-status`. No force, no main.
- [ ] **Step 4:** Report: what changed, test evidence (commands + pass counts), screenshots, untested-on-Mac list.
