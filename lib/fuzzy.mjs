/**
 * Fuzzy path matching with fzy's scoring: rewards matches after separators, capitals and
 * consecutive runs. Pure, so it is unit tested without a filesystem.
 */

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MATCH_BASENAME = 1.0;

export const MAX_MATCH_LENGTH = 1024;
export const MAX_NEEDLE_LENGTH = 64;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Lower-cases one UTF-16 unit at a time, so indexes into the result match the original. */
export function fold(text) {
    const lower = text.toLowerCase();
    if (lower.length === text.length) return lower;
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const char = text[i].toLowerCase();
        out += char.length === 1 ? char : text[i];
    }
    return out;
}

const isLowerLetter = char => char !== char.toUpperCase();
const isUpperLetter = char => char !== char.toLowerCase();

function bonusAt(text, index) {
    if (index === 0) return SCORE_MATCH_SLASH;
    const previous = text[index - 1];
    if (previous === '/') return SCORE_MATCH_SLASH;
    if (previous === '-' || previous === '_' || previous === ' ') return SCORE_MATCH_WORD;
    if (previous === '.') return SCORE_MATCH_DOT;
    if (isLowerLetter(previous) && isUpperLetter(text[index])) return SCORE_MATCH_CAPITAL;
    return 0;
}

export function isSubsequence(needle, haystack) {
    let at = 0;
    for (let i = 0; i < needle.length; i++) {
        at = haystack.indexOf(needle[i], at);
        if (at === -1) return false;
        at++;
    }
    return true;
}

// Score matrices reused across candidates; they only ever grow.
let matrixD = new Float64Array(0);
let matrixM = new Float64Array(0);
let bonusRow = new Float64Array(0);

/** `needle` must already be folded and a subsequence of `lowerText`. */
export function fuzzyScore(needle, text, lowerText) {
    const n = needle.length;
    const m = text.length;
    if (n === m) return { score: Infinity, positions: Array.from({ length: n }, (_, i) => i) };
    if (matrixD.length < n * m) { matrixD = new Float64Array(n * m * 2); matrixM = new Float64Array(n * m * 2); }
    if (bonusRow.length < m) bonusRow = new Float64Array(m * 2);
    const D = matrixD;
    const M = matrixM;
    for (let j = 0; j < m; j++) bonusRow[j] = bonusAt(text, j);
    for (let i = 0; i < n; i++) {
        let previousScore = -Infinity;
        const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
        const row = i * m;
        const above = (i - 1) * m;
        for (let j = 0; j < m; j++) {
            if (needle[i] === lowerText[j]) {
                let score = -Infinity;
                if (i === 0) score = j * SCORE_GAP_LEADING + bonusRow[j];
                else if (j > 0) score = Math.max(M[above + j - 1] + bonusRow[j], D[above + j - 1] + SCORE_MATCH_CONSECUTIVE);
                D[row + j] = score;
                M[row + j] = previousScore = Math.max(score, previousScore + gap);
            } else {
                D[row + j] = -Infinity;
                M[row + j] = previousScore = previousScore + gap;
            }
        }
    }
    const positions = new Array(n);
    let matchRequired = false;
    for (let i = n - 1, j = m - 1; i >= 0; i--) {
        for (; j >= 0; j--) {
            const at = i * m + j;
            if (D[at] !== -Infinity && (matchRequired || D[at] === M[at])) {
                matchRequired = i > 0 && j > 0 && M[at] === D[(i - 1) * m + j - 1] + SCORE_MATCH_CONSECUTIVE;
                positions[i] = j--;
                break;
            }
        }
    }
    return { score: M[(n - 1) * m + m - 1], positions };
}

/** The folded, whitespace-free form of what the user typed. */
export const needleFor = query => fold(String(query).replace(/\s+/g, '')).slice(0, MAX_NEEDLE_LENGTH);

/**
 * Ranks `[relativePath, isDir]` entries against `query`, best first, as
 * `[relativePath, isDir, matchedPositions]`. An empty query keeps index order.
 */
export function rank(entries, query, limit) {
    const needle = needleFor(query);
    if (!needle) return entries.slice(0, limit).map(([relative, isDir]) => [relative, isDir, []]);
    const scored = [];
    for (const [relative, isDir] of entries) {
        if (relative.length > MAX_MATCH_LENGTH) continue;
        const lower = fold(relative);
        if (!isSubsequence(needle, lower)) continue;
        const { score, positions } = fuzzyScore(needle, relative, lower);
        // Prefer entries whose own name holds the end of the match over ones matched by a parent.
        const nameBonus = positions[positions.length - 1] > relative.lastIndexOf('/') ? SCORE_MATCH_BASENAME : 0;
        scored.push({ relative, isDir, score: score + nameBonus, positions });
    }
    scored.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length || collator.compare(a.relative, b.relative));
    return scored.slice(0, limit).map(item => [item.relative, item.isDir, item.positions]);
}
