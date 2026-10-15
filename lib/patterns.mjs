/**
 * The "Always hide" setting: comma-separated globs such as `.DS_Store, *.pyc, dist/cache`.
 * A pattern without a slash matches a name anywhere; one with a slash matches the path from
 * the tree's root. `*` and `?` stay within one name, `**` crosses folders. Pure, so it is
 * unit tested.
 */

const escapeRegExp = text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function globSource(glob) {
    let source = '';
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*' && glob[index + 1] === '*') {
            // `**/` matches zero or more whole folders; a bare `**` matches anything.
            if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; }
            else { source += '.*'; index += 1; }
        } else if (char === '*') source += '[^/]*';
        else if (char === '?') source += '[^/]';
        else source += escapeRegExp(char);
    }
    return source;
}

/** Splits the setting into trimmed patterns; empty ones are dropped. */
export function parsePatterns(text) {
    return String(text ?? '').split(',').map(part => part.trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * A predicate `(relativePath, name) => boolean` for the patterns in `text`, or null when there
 * are none, so callers can skip the check entirely.
 */
export function compileExcludes(text) {
    const patterns = parsePatterns(text);
    if (!patterns.length) return null;
    const byName = [];
    const byPath = [];
    for (const pattern of patterns) {
        const anchored = pattern.replace(/^\/+/, '');
        (pattern.includes('/') ? byPath : byName).push(globSource(anchored));
    }
    const nameRE = byName.length ? new RegExp(`^(?:${byName.join('|')})$`) : null;
    const pathRE = byPath.length ? new RegExp(`^(?:${byPath.join('|')})$`) : null;
    return (relative, name) => Boolean((nameRE && nameRE.test(name)) || (pathRE && pathRE.test(relative)));
}
