/** File name rules for create, rename and duplicate. Pure, so they are unit tested. */

const MAX_NAME_BYTES = 255;

/** Why `name` can't be one path segment, or null when it can. */
export function nameProblem(name) {
    if (typeof name !== 'string' || name.length === 0) return 'Enter a name.';
    if (name.trim().length === 0) return 'A name can\'t be only spaces.';
    if (name === '.' || name === '..') return `"${name}" is not a valid name.`;
    if (name.includes('/')) return 'A name can\'t contain "/".';
    if (name.includes('\0')) return 'A name can\'t contain a null character.';
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name can\'t contain control characters.';
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'That name is too long.';
    return null;
}

/**
 * Splits what was typed into a new-item box into segments, so `src/lib/a.js` creates the
 * folders on the way. Leading, trailing and doubled slashes are dropped. Throws when a
 * segment is not a valid name.
 */
export function splitTyped(typed) {
    if (typeof typed !== 'string') throw new Error('Enter a name.');
    const segments = typed.split('/').filter(Boolean);
    if (!segments.length) throw new Error('Enter a name.');
    for (const segment of segments) {
        const problem = nameProblem(segment);
        if (problem) throw new Error(problem);
    }
    return segments;
}

/** `name.ext` -> [`name`, `.ext`]; folders and dotfiles without another dot keep it all. */
export function splitExtension(name, isDir) {
    if (isDir) return [name, ''];
    const dot = name.lastIndexOf('.');
    return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * The first free "copy" name for `name`, in Finder's style: `a copy.txt`, then `a copy 2.txt`.
 * A name that is already a copy counts on from its number instead of growing `copy copy`.
 */
export function copyName(name, isDir, taken) {
    const [stem, extension] = splitExtension(name, isDir);
    const match = / copy(?: (\d+))?$/.exec(stem);
    const base = match ? stem.slice(0, match.index) : stem;
    let number = match ? Number(match[1] ?? 1) + 1 : 1;
    for (;; number++) {
        const candidate = `${base} copy${number === 1 ? '' : ` ${number}`}${extension}`;
        if (Buffer.byteLength(candidate, 'utf8') > MAX_NAME_BYTES) throw new Error('That name is too long to copy.');
        if (!taken(candidate)) return candidate;
    }
}
