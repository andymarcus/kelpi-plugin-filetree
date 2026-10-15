/**
 * Parses `git status --porcelain=v2 -z --branch`. Pure, so it is unit tested without git.
 *
 * Each changed path gets one code, the one worth showing in a file tree:
 *   U conflict, D deleted, M modified (also type changes), R renamed, A added (also copies),
 *   ? untracked, ! ignored.
 * A path ending in `/` stands for a whole folder: git collapses untracked and ignored folders.
 */

/** Higher wins when a folder sums up the changes inside it. */
export const SEVERITY = Object.freeze({ '!': 0, '?': 1, A: 2, R: 3, M: 4, D: 5, U: 6 });

/** One code from an `XY` pair: the worktree side wins, since that is what is on disk now. */
export function codeFor(xy) {
    const [x, y] = xy;
    if (y === 'D' || (x === 'D' && y === '.')) return 'D';
    if (x === 'A' || x === 'C') return 'A';
    if (x === 'R') return 'R';
    return 'M';
}

/**
 * Returns `{ branch, entries, truncated }`:
 * - `branch`: `{ head, oid, upstream, ahead, behind }`; `head` is null when detached.
 * - `entries`: `[relativePath, code, staged, originalPath]`, `staged` is true when the index
 *   holds part of the change, `originalPath` is set for renames and copies.
 */
export function parseStatus(output, limit = Infinity) {
    const text = typeof output === 'string' ? output : output.toString('utf8');
    const fields = text.split('\0');
    const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0 };
    const entries = [];
    let truncated = false;
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (!field) continue;
        const kind = field[0];
        if (kind === '#') {
            const [, key, ...rest] = field.split(' ');
            const value = rest.join(' ');
            if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
            else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
            else if (key === 'branch.upstream') branch.upstream = value;
            else if (key === 'branch.ab') {
                const match = /^\+(\d+) -(\d+)$/.exec(value);
                if (match) { branch.ahead = Number(match[1]); branch.behind = Number(match[2]); }
            }
            continue;
        }
        let entry = null;
        if (kind === '?' || kind === '!') {
            entry = [field.slice(2), kind, false, null];
        } else if (kind === '1') {
            // 1 XY sub mH mI mW hH hI path
            const parts = field.split(' ');
            const xy = parts[1];
            entry = [parts.slice(8).join(' '), codeFor(xy), xy[0] !== '.', null];
        } else if (kind === '2') {
            // 2 XY sub mH mI mW hH hI Xscore path, then the original path as its own field.
            const parts = field.split(' ');
            const xy = parts[1];
            const original = fields[++index] ?? null;
            entry = [parts.slice(9).join(' '), codeFor(xy), xy[0] !== '.', original];
        } else if (kind === 'u') {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            const parts = field.split(' ');
            entry = [parts.slice(10).join(' '), 'U', false, null];
        }
        if (!entry || !entry[0]) continue;
        if (entries.length >= limit) { truncated = true; continue; }
        entries.push(entry);
    }
    return { branch, entries, truncated };
}
