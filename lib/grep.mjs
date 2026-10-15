/**
 * Content search output parsing, for ripgrep's `--json` and plain `grep --null -n`. Pure, so it
 * is unit tested. A match is `{ path, line, text, ranges }`: `path` relative to the searched
 * folder, `text` a trimmed snippet of the line, `ranges` `[start, end]` UTF-16 offsets into it.
 */

export const SNIPPET_LENGTH = 160;
const SNIPPET_LEAD = 40;

/** UTF-8 byte offset -> UTF-16 offset in `text`. */
export function utf16Offset(text, byteOffset) {
    return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Trims the line to something a sidebar row can show: no line break, no leading indent, and a
 * window around the first match when the line is long. Ranges move with the text.
 */
export function snippet(line, ranges) {
    let text = line.replace(/\r?\n$/, '');
    let shift = 0;
    const indent = /^\s*/.exec(text)[0].length;
    if (indent) { text = text.slice(indent); shift += indent; }
    const first = ranges.length ? Math.max(0, ranges[0][0] - shift) : 0;
    let prefix = '';
    if (text.length > SNIPPET_LENGTH && first > SNIPPET_LEAD) {
        const start = first - SNIPPET_LEAD;
        text = text.slice(start);
        shift += start;
        prefix = '…';
    }
    let suffix = '';
    if (text.length > SNIPPET_LENGTH) { text = text.slice(0, SNIPPET_LENGTH); suffix = '…'; }
    const moved = ranges
        .map(([start, end]) => [start - shift + prefix.length, end - shift + prefix.length])
        .filter(([start, end]) => end > prefix.length && start < prefix.length + text.length)
        .map(([start, end]) => [Math.max(prefix.length, start), Math.min(prefix.length + text.length, end)]);
    return { text: prefix + text + suffix, ranges: moved };
}

/** One `rg --json` line -> a match, or null for every other message kind and for non-UTF-8 data. */
export function parseRipgrepLine(raw) {
    if (!raw) return null;
    let message;
    try { message = JSON.parse(raw); } catch { return null; }
    if (message?.type !== 'match') return null;
    const data = message.data;
    const path = data?.path?.text;
    const line = data?.lines?.text;
    if (typeof path !== 'string' || typeof line !== 'string' || typeof data.line_number !== 'number') return null;
    const ranges = (data.submatches ?? [])
        .filter(sub => typeof sub.start === 'number' && typeof sub.end === 'number')
        .map(sub => [utf16Offset(line, sub.start), utf16Offset(line, sub.end)]);
    return { path: path.replace(/^\.\//, ''), line: data.line_number, ...snippet(line, ranges) };
}

/** Every occurrence of `needle` in `text`, for grep output that carries no match offsets. */
export function findRanges(text, needle, ignoreCase) {
    if (!needle) return [];
    const haystack = ignoreCase ? text.toLowerCase() : text;
    const target = ignoreCase ? needle.toLowerCase() : needle;
    const ranges = [];
    for (let at = haystack.indexOf(target); at !== -1 && ranges.length < 32; at = haystack.indexOf(target, at + target.length)) {
        ranges.push([at, at + target.length]);
    }
    return ranges;
}

/** One `grep --null -n` line, `path\0line:text` -> a match, or null. */
export function parseGrepLine(raw, needle, ignoreCase) {
    const nul = raw.indexOf('\0');
    if (nul === -1) return null;
    const rest = raw.slice(nul + 1);
    const colon = rest.indexOf(':');
    const line = Number(rest.slice(0, colon));
    if (colon === -1 || !Number.isSafeInteger(line)) return null;
    const text = rest.slice(colon + 1);
    return { path: raw.slice(0, nul).replace(/^\.\//, ''), line, ...snippet(text, findRanges(text, needle, ignoreCase)) };
}

/** ripgrep's smart case, for the grep fallback: ignore case unless the query has a capital. */
export const smartCaseIgnores = query => query === query.toLowerCase();
