// The build's short git hash for the version label (src/version.ts): "-dirty" when tracked files have
// uncommitted changes, "unknown" when git isn't available or this isn't a checkout. Untracked files
// don't count (a worktree's node_modules symlink, say). No shell, so it works the same on Windows.
import { execFileSync } from "node:child_process";

export function buildHash(cwd) {
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const hash = git(["rev-parse", "--short", "HEAD"]);
		if (!/^[0-9a-f]{7,40}$/.test(hash)) return "unknown";
		return git(["status", "--porcelain", "--untracked-files=no"]) ? `${hash}-dirty` : hash;
	} catch {
		return "unknown";
	}
}
