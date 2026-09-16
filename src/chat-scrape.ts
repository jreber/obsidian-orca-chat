export interface ScrapedMessage {
	role: "user" | "assistant";
	text: string;
}

// Same coarse heuristic Orca's own Chat View falls back to when it has no
// local transcript to read (native-chat-scrape-fallback.ts): split on
// blank-line runs, guess role by whether the segment's first line starts
// with a shell/agent prompt marker. Deliberately approximate.
const USER_PROMPT_MARKERS = ["$", "%", ">", "#", "❯", "➜", "»"];

function looksLikeUserPrompt(segment: string): boolean {
	const firstLine = segment.split("\n", 1)[0]?.trimStart() ?? "";
	if (firstLine.length === 0) return false;
	return USER_PROMPT_MARKERS.includes(firstLine[0]);
}

export function scrapeToMessages(lines: string[]): ScrapedMessage[] {
	const cleaned = lines.join("\n").trim();
	if (!cleaned) return [];
	const segments = cleaned
		.split(/\n{2,}/)
		.map((s) => s.trim())
		.filter(Boolean);
	return segments.map((segment) => ({
		role: looksLikeUserPrompt(segment) ? "user" : "assistant",
		text: segment,
	}));
}
