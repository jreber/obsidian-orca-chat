// Vendored stand-in for Orca's src/shared/runtime-types.ts.
//
// The original is a barrel that re-exports ~100 types covering browser,
// terminal, worktree, and computer-use runtime surfaces — none of which are
// used by the E2EE handshake/socket code or the session.tabs/nativeChat RPCs
// this plugin vendors. Pulling that whole barrel in would drag along many
// further sibling files with no bearing on the wire protocol.
//
// The remote-runtime-client/-request-socket/-request-response-router files
// only need `RuntimeStatus` as an optional generic type parameter for the
// status-preflight code path (`sendRemoteRuntimeRequestWithStatusPreflight`).
// Narrowing it to `unknown` preserves type safety at those call sites without
// vendoring Orca's full contract surface. No protocol/handshake/crypto logic
// depends on this type's shape.
export type RuntimeStatus = unknown;
