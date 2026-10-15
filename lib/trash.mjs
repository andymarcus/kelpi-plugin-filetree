/**
 * Moving files to the system Trash, and finding where they went so Undo can put them back.
 * Nothing here deletes permanently: without a working trash, the call fails.
 *
 * - macOS: NSFileManager's trashItemAtURL through JavaScript for Automation. It needs no
 *   Finder automation permission, keeps Finder's Put Back working, and reports where each
 *   item landed.
 * - Linux: `gio trash`, then the item is found again through the XDG trash's .trashinfo files.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
});

// Trashes every path given as an argument and prints one JSON result per path.
const MAC_SCRIPT = `
function run(argv) {
    ObjC.import('Foundation');
    const manager = $.NSFileManager.defaultManager;
    return JSON.stringify(argv.map(item => {
        const landed = $();
        const error = $();
        const ok = manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(item), landed, error);
        if (ok) return { to: ObjC.unwrap(landed.path) };
        return { error: ObjC.unwrap(error.localizedDescription) || 'Could not move this item to the Trash.' };
    }));
}`;

async function trashMac(paths) {
    const output = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, ...paths]);
    const results = JSON.parse(output.trim());
    if (!Array.isArray(results) || results.length !== paths.length) throw new Error('The Trash gave an unexpected answer.');
    return results.map((result, index) => ({ from: paths[index], to: typeof result?.to === 'string' ? result.to : null, error: result?.error ?? null }));
}

/** `[Trash Info]` file -> `{ path, date }`, with the percent-encoded path decoded. */
export function parseTrashInfo(text) {
    let original = null;
    let date = null;
    for (const line of String(text).split(/\r?\n/)) {
        if (line.startsWith('Path=')) {
            try { original = decodeURIComponent(line.slice(5)); } catch { original = null; }
        } else if (line.startsWith('DeletionDate=')) {
            date = line.slice(13);
        }
    }
    return original ? { path: original, date } : null;
}

const xdgTrash = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Trash');

/** The newest home-trash entry for `original`, as its path under Trash/files, or null. */
async function findInXdgTrash(original) {
    const infoDir = path.join(xdgTrash(), 'info');
    let names;
    try { names = await fsp.readdir(infoDir); } catch { return null; }
    let best = null;
    for (const name of names) {
        if (!name.endsWith('.trashinfo')) continue;
        let info;
        try { info = parseTrashInfo(await fsp.readFile(path.join(infoDir, name), 'utf8')); } catch { continue; }
        if (info?.path !== original) continue;
        if (!best || (info.date ?? '') > (best.date ?? '')) best = { name: name.slice(0, -'.trashinfo'.length), date: info.date };
    }
    return best ? path.join(xdgTrash(), 'files', best.name) : null;
}

async function trashLinux(paths) {
    const results = [];
    for (const item of paths) {
        try {
            await run('gio', ['trash', '--', item]);
            results.push({ from: item, to: await findInXdgTrash(item), error: null });
        } catch (error) {
            const missing = error?.code === 'ENOENT';
            results.push({ from: item, to: null, error: missing ? 'No trash is available (gio is not installed).' : (String(error?.stderr || '').trim() || 'Could not move this item to the Trash.') });
        }
    }
    return results;
}

/** `[{ from, to, error }]`, one per path, in order. `to` is null when the location is unknown. */
export async function moveToTrash(paths) {
    if (process.platform === 'darwin') return trashMac(paths);
    if (process.platform === 'linux') return trashLinux(paths);
    throw new Error('Moving to the Trash is not supported on this system.');
}

/** Removes the .trashinfo record of an item restored from the XDG trash, so it isn't listed twice. */
export async function forgetTrashRecord(trashedPath) {
    if (process.platform !== 'linux') return;
    const files = path.join(xdgTrash(), 'files');
    if (path.dirname(trashedPath) !== files) return;
    await fsp.rm(path.join(xdgTrash(), 'info', `${path.basename(trashedPath)}.trashinfo`), { force: true });
}
