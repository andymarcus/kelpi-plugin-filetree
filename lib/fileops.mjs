/**
 * Create, move (which is also rename and undo) and duplicate. None of them ever replaces an
 * existing item: a name that is taken is an error the user sees, not an overwrite.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { copyName, nameProblem, splitTyped } from './names.mjs';

const absolute = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('an absolute path is required');
    return path.resolve(value);
};

const isWithin = (child, base) => child === base || child.startsWith(base + path.sep);

function friendly(error, target) {
    const name = target ? `"${path.basename(target)}"` : 'That item';
    switch (error?.code) {
        case 'EEXIST': case 'ENOTEMPTY': case 'ERR_FS_CP_EEXIST': return new Error(`${name} already exists.`);
        case 'ENOENT': return new Error(`${name} no longer exists.`);
        case 'EACCES': case 'EPERM': return new Error('Permission denied.');
        case 'EROFS': return new Error('This disk is read-only.');
        case 'ENOSPC': return new Error('The disk is full.');
        case 'ENAMETOOLONG': return new Error('That name is too long.');
        case 'ENOTDIR': return new Error(`${name} is not a folder.`);
        default: return error instanceof Error ? error : new Error(String(error));
    }
}

// Errors that mean the target was already there: a failed copy must then never be cleaned up,
// since what is at the target is not ours.
const isExists = error => ['EEXIST', 'ENOTEMPTY', 'ERR_FS_CP_EEXIST'].includes(error?.code);

const lstatOrNull = async target => { try { return await fsp.lstat(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };

/**
 * Creates a file or folder from what was typed into the new-item box; `a/b/c.txt` makes `a`
 * and `b` on the way. Returns the new item's path and `undo`, the topmost item this created,
 * which is what Undo moves to the Trash.
 */
export async function createItem({ dir: rawDir, name, kind }) {
    const dir = absolute(rawDir);
    if (kind !== 'file' && kind !== 'folder') throw new Error('kind must be file or folder');
    const segments = splitTyped(name);
    let undo = null;
    let current = dir;
    try {
        for (const segment of segments.slice(0, -1)) {
            current = path.join(current, segment);
            const stat = await lstatOrNull(current);
            if (stat && !stat.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
            if (!stat) { await fsp.mkdir(current); undo ??= current; }
        }
        const target = path.join(current, segments[segments.length - 1]);
        current = target;
        if (kind === 'folder') await fsp.mkdir(target);
        else await (await fsp.open(target, 'wx')).close();
        return { path: target, undo: undo ?? target };
    } catch (error) {
        throw friendly(error, current);
    }
}

/** Same item, for a rename that only changes case on a case-insensitive disk. */
const sameItem = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;

async function moveOne(from, to) {
    if (from === to) return;
    if (isWithin(to, from)) throw new Error(`"${path.basename(from)}" can't be moved into itself.`);
    const [source, existing] = await Promise.all([lstatOrNull(from), lstatOrNull(to)]);
    if (!source) throw friendly({ code: 'ENOENT' }, from);
    if (existing && !sameItem(source, existing)) throw friendly({ code: 'EEXIST' }, to);
    try {
        await fsp.rename(from, to);
    } catch (error) {
        if (error?.code !== 'EXDEV') throw friendly(error, to);
        // Another disk: copy, then remove the original only once the copy is complete.
        try {
            await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        } catch (copyError) {
            if (!isExists(copyError)) await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
            throw friendly(copyError, to);
        }
        await fsp.rm(from, { recursive: true });
    }
}

/**
 * Moves each `{ from, to }` in order. If one fails, the ones already moved are put back, so a
 * multi-item move happens completely or not at all.
 */
export async function moveItems(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) throw new Error('nothing to move');
    const plan = pairs.map(pair => ({ from: absolute(pair?.from), to: absolute(pair?.to) }));
    for (const { to } of plan) { const problem = nameProblem(path.basename(to)); if (problem) throw new Error(problem); }
    const done = [];
    try {
        for (const pair of plan) { await moveOne(pair.from, pair.to); done.push(pair); }
    } catch (error) {
        for (const pair of done.reverse()) await moveOne(pair.to, pair.from).catch(() => {});
        throw error;
    }
    return { moved: plan };
}

/** Copies an item next to itself as `name copy`, `name copy 2` and so on. */
export async function duplicateItem({ path: raw }) {
    const source = absolute(raw);
    const stat = await lstatOrNull(source);
    if (!stat) throw friendly({ code: 'ENOENT' }, source);
    const dir = path.dirname(source);
    // Case-insensitive disks (the macOS default) treat `A copy` and `a copy` as one name.
    const fold = process.platform === 'darwin' || process.platform === 'win32' ? name => name.toLowerCase() : name => name;
    const taken = new Set((await fsp.readdir(dir)).map(fold));
    const name = copyName(path.basename(source), stat.isDirectory(), candidate => taken.has(fold(candidate)));
    const target = path.join(dir, name);
    try {
        await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_EXCL });
    } catch (error) {
        if (!isExists(error)) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        throw friendly(error, target);
    }
    return { path: target };
}
