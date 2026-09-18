export interface LineRange {
	start: number;
	end: number;
}

export function formatLocation(filePath: string | null, lineRange: LineRange | null): string | null {
	if (!filePath) return null;
	if (!lineRange) return filePath;
	const lines = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
	return `${filePath}:${lines}`;
}

// Building the citation as a real obsidian://open link — rather than a bare bracketed path —
// does double duty: it's clickable in the embedded webview (once the host intercepts the
// resulting navigation), and it demonstrates the link format to the agent in-context, so it
// tends to reuse the same format when citing vault files back to us, with no separate
// instruction needed.
export function buildAnnotateMessage(
	selection: string,
	question: string,
	location: string | null,
	citationUri?: string | null,
): string {
	const lines = selection.split("\n");
	const citation = location ? (citationUri ? ` [${location}](${citationUri})` : ` [${location}]`) : "";
	const quoted = lines.map((line, i) => `> ${line}${i === lines.length - 1 ? citation : ""}`).join("\n");
	return `${quoted}\n\n${question}`;
}

// Obsidian's own deep-link scheme for opening a file in a named vault. Built with
// URLSearchParams (not encodeURIComponent) specifically because it also escapes `(` and `)` —
// encodeURIComponent leaves those unescaped, and an unescaped `)` in the URL would prematurely
// close the enclosing markdown link syntax `[text](url)`.
export function buildObsidianOpenUri(vaultName: string, filePath: string): string {
	const params = new URLSearchParams({ vault: vaultName, file: filePath });
	return `obsidian://open?${params.toString()}`;
}

export function lineRangeFromEditorCursors(fromLine: number, toLine: number): LineRange {
	return { start: fromLine + 1, end: toLine + 1 };
}

export function sectionInfoToLineTag(lineStart: number, lineEnd: number): string {
	return `${lineStart + 1}-${lineEnd + 1}`;
}

export function parseLineTag(tag: string | null | undefined): LineRange | null {
	if (!tag) return null;
	const match = /^(\d+)-(\d+)$/.exec(tag);
	if (!match) return null;
	return { start: Number(match[1]), end: Number(match[2]) };
}

export function readingModeLineRange(startTag: string | null | undefined, endTag: string | null | undefined): LineRange | null {
	const start = parseLineTag(startTag);
	const end = parseLineTag(endTag);
	if (!start || !end) return null;
	return { start: start.start, end: end.end };
}
