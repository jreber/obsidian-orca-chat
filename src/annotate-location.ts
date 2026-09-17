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

export function buildAnnotateMessage(selection: string, question: string, location: string | null): string {
	const body = `${selection}\n\n${question}`;
	return location ? `[${location}]\n${body}` : body;
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
