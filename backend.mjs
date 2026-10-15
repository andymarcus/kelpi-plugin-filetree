/**
 * File Tree backend: filesystem access for the sidebar view.
 *
 * The view runs in a sandboxed iframe with no filesystem, so everything that touches the disk
 * or the OS lives here and is exposed as the `andymarcus.filetree.fs@1` service. Replies stay
 * well under Kelpi's 256 KiB JSON envelope: listings use compact tuples and are truncated, and
 * searches rank on this side so an index never crosses the bridge.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { rank } from './lib/fuzzy.mjs';
import { compileExcludes } from './lib/patterns.mjs';
import { GitTracker, codeOf, folderCodeOf } from './lib/gitrepo.mjs';
import { createItem, duplicateItem, moveItems } from './lib/fileops.mjs';
import { forgetTrashRecord, moveToTrash } from './lib/trash.mjs';
import { searchContent, stopContentSearch } from './lib/contentsearch.mjs';

const PLUGIN_ID = 'andymarcus.filetree';
const PROVIDER_ID = `${PLUGIN_ID}.fs.node`;

// Listing limits. Rows are measured in UTF-8 bytes so a reply stays inside the envelope.
const MAX_LIST_ENTRIES = 3000;
const LIST_BYTE_BUDGET = 180 * 1024;
// Sorting by date or size needs a stat of every entry; past this many, name order is used.
const MAX_STAT_SORTED = 20000;
// Child counts need one readdir per folder; skip them for very wide directories.
const MAX_COUNTED_FOLDERS = 400;
const COUNT_CACHE_LIMIT = 4000;
const STAT_CONCURRENCY = 48;
// How long a listing waits for git status before answering without it (a `git` event follows).
const GIT_WAIT_MS = 400;
const GIT_WAIT_HIDING_MS = 3000;

// Search limits. Folders in PRUNE are listed but never descended into, so a single
// node_modules cannot exhaust the index before the project's own files are reached.
const MAX_INDEX_ENTRIES = 60000;
const INDEX_TIME_BUDGET_MS = 4000;
const INDEX_TTL_MS = 30000;
// A busy folder marks the index dirty constantly; rebuild it at most this often.
const INDEX_MIN_REBUILD_MS = 3000;
const INDEX_CACHE_LIMIT = 3;
const MAX_RESULTS = 200;
const PRUNE = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', 'Pods', 'DerivedData']);

// Watch leases: views renew every 15 s; a lease that is not renewed lapses.
const LEASE_MS = 45000;
const MAX_WATCHED_DIRS = 512;
const CHANGE_DEBOUNCE_MS = 120;
const MAX_CHANGED_FILES = 400;

// Pane directory lookups: a pane whose terminal cannot be found is not scanned again for this long.
const PANE_MISS_TTL_MS = 30000;

// Preview: how much of a file is read, and how much of it is sent.
const PREVIEW_BYTES = 8192;
const PREVIEW_LINES = 16;
const PREVIEW_LINE_LENGTH = 240;

// The daemon's PATH may lack /usr/sbin, so prefer the tools' standard homes.
const tool = (preferred, name) => (fs.existsSync(preferred) ? preferred : name);
const PS = tool('/bin/ps', 'ps');
const LSOF = tool('/usr/sbin/lsof', 'lsof');

const run = (file, args, options = {}) => new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 5000, ...options }, (error, stdout) => {
        // Keep partial output: lsof exits 1 when only some of the asked-for processes were readable.
        if (error) { error.stdout = stdout; reject(error); } else resolve(stdout);
    });
});

const absolute = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('an absolute path is required');
    return path.resolve(value);
};

const isWithin = (child, base) => base === path.sep || child === base || child.startsWith(base + path.sep);
/** `child` relative to `base` with `/` separators, or null when it is outside. */
const relativeTo = (child, base) => (isWithin(child, base) ? path.relative(base, child).split(path.sep).join('/') : null);

const describeError = error => {
    switch (error?.code) {
        case 'ENOENT': return 'This folder no longer exists.';
        case 'EACCES': case 'EPERM': return 'Permission denied.';
        case 'ENOTDIR': return 'Not a folder.';
        case 'ELOOP': return 'Too many symbolic links.';
        default: return error?.message ?? String(error);
    }
};

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** Insertion-ordered Map trimmed from the oldest end. */
function remember(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
}

/** Resolves to `fallback` if `promise` takes longer than `ms`; its rejection becomes `fallback` too. */
const within = (promise, ms, fallback = null) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
});

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isFolderKind = kind => kind === 'd' || kind === 'L';

// Compiled "Always hide" patterns, by setting text.
const excludeCache = new Map();
function excludesFor(text) {
    const key = String(text ?? '');
    if (!excludeCache.has(key)) remember(excludeCache, key, compileExcludes(key), 8);
    return excludeCache.get(key);
}

// --- Git -------------------------------------------------------------------------------------

let emitEvent = () => {};
const git = new GitTracker(top => emitEvent('git', { top }));

/** The repository holding `dir` and its status, waiting at most `wait` ms for git. */
async function gitFor(dir, wait) {
    const repo = await git.repoFor(dir);
    if (!repo) return { repo: null, status: null };
    const status = await within(git.status(repo), wait, null) ?? git.cached(repo);
    return { repo, status };
}

function repoSummary(repo, status) {
    if (!repo) return null;
    if (!status) return { top: repo.top, pending: true };
    const { branch } = status;
    return { top: repo.top, branch: branch.head, detached: !branch.head, oid: branch.oid?.slice(0, 7) ?? null, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, changed: status.changed, truncated: status.truncated, pending: false };
}

// --- Listing -------------------------------------------------------------------------------

/**
 * Entry kinds: d folder, f file, L symlink to a folder, l symlink to a file,
 * b broken symlink, o anything else (socket, fifo, device, or a link to one),
 * x a file git knows that was deleted from disk.
 */
async function kindOf(dir, dirent) {
    if (dirent.isDirectory()) return 'd';
    if (dirent.isFile()) return 'f';
    if (dirent.isSymbolicLink()) {
        try {
            const target = await fsp.stat(path.join(dir, dirent.name));
            return target.isDirectory() ? 'L' : target.isFile() ? 'l' : 'o';
        } catch { return 'b'; }
    }
    return 'o';
}

/** `{ size, mtimeMs }`; links report what they point at, since that is what opens. */
async function statOf(full, kind) {
    try {
        const stat = kind === 'l' || kind === 'L' ? await fsp.stat(full) : await fsp.lstat(full);
        return { size: kind === 'f' || kind === 'l' ? stat.size : null, mtimeMs: Math.round(stat.mtimeMs) };
    } catch { return { size: null, mtimeMs: null }; } // vanished between readdir and stat
}

// folder -> { mtimeMs, showHidden, count }. A stat is far cheaper than a readdir.
const childCounts = new Map();

async function countChildren(dir, showHidden) {
    try {
        const { mtimeMs } = await fsp.stat(dir);
        const cached = childCounts.get(dir);
        if (cached && cached.mtimeMs === mtimeMs && cached.showHidden === showHidden) return cached.count;
        const names = await fsp.readdir(dir);
        const count = showHidden ? names.length : names.filter(name => !name.startsWith('.')).length;
        remember(childCounts, dir, { mtimeMs, showHidden, count }, COUNT_CACHE_LIMIT);
        return count;
    } catch { return null; }
}

const extensionOf = name => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

function comparator(sort, foldersFirst) {
    const byName = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const order = {
        name: byName,
        type: (a, b) => collator.compare(extensionOf(a.name), extensionOf(b.name)) || byName(a, b),
        // Newest and largest first; entries without a value go last.
        modified: (a, b) => (b.mtimeMs ?? -Infinity) - (a.mtimeMs ?? -Infinity) || byName(a, b),
        size: (a, b) => (b.size ?? -Infinity) - (a.size ?? -Infinity) || byName(a, b),
    }[sort] ?? byName;
    return foldersFirst ? (a, b) => (isFolderKind(b.kind) - isFolderKind(a.kind)) || order(a, b) : order;
}

async function list({ path: target, root: rawRoot = null, showHidden = true, hideIgnored = false, sort = 'name', foldersFirst = true, exclude = '', gitStatus = true }) {
    const dir = absolute(target);
    const root = typeof rawRoot === 'string' && path.isAbsolute(rawRoot) ? path.resolve(rawRoot) : dir;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { return { path: dir, error: describeError(error), code: error?.code ?? null }; }

    const excludes = excludesFor(exclude);
    const base = relativeTo(dir, root);
    const relativeName = name => (base === null ? name : base ? `${base}/${name}` : name);
    if (!showHidden) dirents = dirents.filter(dirent => !dirent.name.startsWith('.'));
    if (excludes) dirents = dirents.filter(dirent => !excludes(relativeName(dirent.name), dirent.name));

    const { repo, status } = gitStatus ? await gitFor(dir, hideIgnored ? GIT_WAIT_HIDING_MS : GIT_WAIT_MS) : { repo: null, status: null };
    const repoBase = repo ? relativeTo(dir, repo.top) : null;
    const inGitDir = repo ? isWithin(dir, repo.gitDir) : false;

    const kinds = await mapLimit(dirents, STAT_CONCURRENCY, dirent => kindOf(dir, dirent));
    let all = dirents.map((dirent, index) => ({ name: dirent.name, kind: kinds[index], git: null }));

    if (status && repoBase !== null && !inGitDir) {
        const rel = name => (repoBase ? `${repoBase}/${name}` : name);
        for (const entry of all) {
            // The repository's own .git folder is git's business, not the project's.
            entry.git = entry.name === '.git' && !repoBase ? '!' : isFolderKind(entry.kind) ? folderCodeOf(status, rel(entry.name)) : codeOf(status, rel(entry.name));
        }
        if (hideIgnored) all = all.filter(entry => entry.git !== '!');
        // Files git tracks that are gone from disk show as deleted rows, so the change is visible.
        const present = new Set(all.map(entry => entry.name));
        for (const name of status.deleted.get(repoBase) ?? []) {
            if (present.has(name) || (!showHidden && name.startsWith('.')) || (excludes && excludes(relativeName(name), name))) continue;
            all.push({ name, kind: 'x', git: 'D' });
        }
    } else if (inGitDir) {
        // Inside .git everything is git's own: dimmed like .git itself, or hidden with it.
        if (hideIgnored) all = [];
        for (const entry of all) entry.git = '!';
    }

    const statAll = (sort === 'modified' || sort === 'size') && all.length <= MAX_STAT_SORTED;
    if (statAll) await mapLimit(all, STAT_CONCURRENCY, async entry => { if (entry.kind !== 'x') Object.assign(entry, await statOf(path.join(dir, entry.name), entry.kind)); });
    all.sort(comparator(statAll ? sort : sort === 'type' ? 'type' : 'name', foldersFirst !== false));

    const shown = all.slice(0, MAX_LIST_ENTRIES);
    if (!statAll) await mapLimit(shown, STAT_CONCURRENCY, async entry => { if (entry.kind !== 'x') Object.assign(entry, await statOf(path.join(dir, entry.name), entry.kind)); });
    const folders = shown.filter(entry => isFolderKind(entry.kind));
    if (folders.length <= MAX_COUNTED_FOLDERS) {
        await mapLimit(folders, STAT_CONCURRENCY, async entry => { entry.count = await countChildren(path.join(dir, entry.name), showHidden); });
    }

    const entries = [];
    let bytes = 0;
    for (const entry of shown) {
        const row = [entry.name, entry.kind, entry.size ?? null, entry.count ?? null, entry.mtimeMs ?? null, entry.git];
        bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        if (bytes > LIST_BYTE_BUDGET) break;
        entries.push(row);
    }
    return { path: dir, entries, total: all.length, repo: repoSummary(repo, status) };
}

// --- Fuzzy search ----------------------------------------------------------------------------

// `${root}\0${hidden}\0${exclude}` -> { root, index, builtAt, building, dirty }, least recently used first.
const indexes = new Map();

async function buildIndex(root, showHidden, excludes) {
    const entries = [];
    const started = Date.now();
    let truncated = false;
    // Breadth first, so shallow paths are indexed (and shown for an empty query) first.
    let frontier = [''];
    while (frontier.length && !truncated) {
        const next = [];
        for (const relative of frontier) {
            let dirents;
            try { dirents = await fsp.readdir(path.join(root, relative), { withFileTypes: true }); }
            catch { continue; }
            dirents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || collator.compare(a.name, b.name));
            for (const dirent of dirents) {
                if (!showHidden && dirent.name.startsWith('.')) continue;
                const child = relative ? `${relative}/${dirent.name}` : dirent.name;
                if (excludes && excludes(child, dirent.name)) continue;
                const isDir = dirent.isDirectory();
                entries.push([child, isDir]);
                if (isDir && !PRUNE.has(dirent.name)) next.push(child);
                if (entries.length >= MAX_INDEX_ENTRIES) { truncated = true; break; }
            }
            if (truncated) break;
            if (Date.now() - started > INDEX_TIME_BUDGET_MS) { truncated = true; break; }
        }
        frontier = next;
    }
    return { entries, truncated };
}

async function indexFor(root, showHidden, exclude) {
    const key = `${root}\0${showHidden}\0${exclude}`;
    const entry = indexes.get(key) ?? { root, index: null, builtAt: 0, building: null, dirty: false };
    remember(indexes, key, entry, INDEX_CACHE_LIMIT);
    if (entry.building) return entry.building;
    const age = Date.now() - entry.builtAt;
    if (entry.index && age < INDEX_TTL_MS && (!entry.dirty || age < INDEX_MIN_REBUILD_MS)) return entry.index;
    // Clear the mark before building, so a change made during the build marks it again.
    entry.dirty = false;
    entry.building = buildIndex(root, showHidden, excludesFor(exclude)).then(
        index => { entry.index = index; entry.builtAt = Date.now(); entry.building = null; return index; },
        error => { entry.building = null; throw error; });
    return entry.building;
}

function markIndexesDirty(dir) {
    for (const entry of indexes.values()) if (isWithin(dir, entry.root)) entry.dirty = true;
}

async function search({ root: target, query = '', showHidden = true, hideIgnored = false, exclude = '' }) {
    const root = absolute(target);
    const index = await indexFor(root, showHidden, String(exclude ?? ''));
    let entries = index.entries;
    if (hideIgnored) {
        const { repo, status } = await gitFor(root, GIT_WAIT_HIDING_MS);
        const prefix = repo ? relativeTo(root, repo.top) : null;
        if (status && prefix !== null) {
            entries = entries.filter(([relative]) => {
                const inRepo = prefix ? `${prefix}/${relative}` : relative;
                if (inRepo === '.git' || inRepo.startsWith('.git/')) return false;
                return codeOf(status, inRepo) !== '!';
            });
        }
    }
    return { root, results: rank(entries, query, MAX_RESULTS), indexed: index.entries.length, truncated: index.truncated };
}

async function grep({ token, root: target, query = '', regex = false, showHidden = true, exclude = '' }) {
    if (typeof token !== 'string' || !token) throw new Error('a search token is required');
    const root = absolute(target);
    return searchContent({ token, root, query: String(query).slice(0, 1000), regex: Boolean(regex), showHidden, prune: [...PRUNE].filter(name => name !== '.git'), exclude: String(exclude ?? '') });
}

// --- Watching --------------------------------------------------------------------------------

const leases = new Map();   // token -> { dirs: Set<string>, expires: number }, oldest first
const watchers = new Map(); // dir -> FSWatcher
const pendingChanges = new Set();
const pendingFiles = new Set();
let changeTimer = null;

function queueChange(dir, name = null) {
    pendingChanges.add(dir);
    if (typeof name === 'string' && name && pendingFiles.size < MAX_CHANGED_FILES) pendingFiles.add(path.join(dir, name));
    markIndexesDirty(dir);
    git.touched(dir);
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
        changeTimer = null;
        const dirs = [...pendingChanges];
        const files = [...pendingFiles];
        pendingChanges.clear();
        pendingFiles.clear();
        emitEvent('changed', { dirs, files });
    }, CHANGE_DEBOUNCE_MS);
}

const watchedDirs = () => [...watchers.keys()];
const hasLiveView = () => [...leases.values()].some(lease => lease.expires >= Date.now());

function reconcileWatchers() {
    const now = Date.now();
    const wanted = new Set();
    // Newest leases first, so the view the user just touched is never the one left unwatched.
    for (const [token, lease] of [...leases].reverse()) {
        if (lease.expires < now) { leases.delete(token); continue; }
        for (const dir of lease.dirs) {
            if (wanted.size >= MAX_WATCHED_DIRS) break;
            wanted.add(dir);
        }
    }
    for (const [dir, watcher] of watchers) {
        if (!wanted.has(dir)) { watcher.close(); watchers.delete(dir); }
    }
    for (const dir of wanted) {
        if (watchers.has(dir)) continue;
        try {
            const watcher = fs.watch(dir, { persistent: false }, (_event, name) => queueChange(dir, name));
            watcher.on('error', () => {
                watcher.close();
                watchers.delete(dir);
                // The folder itself went away: its parent's listing is what changed.
                queueChange(dir);
                queueChange(path.dirname(dir), path.basename(dir));
            });
            watchers.set(dir, watcher);
        } catch {
            // Unreadable or vanished; the view shows the listing error instead.
        }
    }
    git.reconcile(watchedDirs());
}

function watch({ token, dirs = [] }) {
    if (typeof token !== 'string' || !token) throw new Error('a watch token is required');
    const valid = new Set();
    for (const dir of Array.isArray(dirs) ? dirs : []) {
        if (typeof dir === 'string' && path.isAbsolute(dir)) valid.add(path.resolve(dir));
    }
    remember(leases, token, { dirs: valid, expires: Date.now() + LEASE_MS }, Infinity);
    reconcileWatchers();
    return { watching: watchers.size };
}

function release({ token }) {
    leases.delete(token);
    stopContentSearch(token);
    reconcileWatchers();
    return { watching: watchers.size };
}

// --- Pane working directory ------------------------------------------------------------------

/**
 * Kelpi only learns a pane's directory when its shell reports it (OSC 7, injected for zsh only),
 * and an agent such as Claude never does. So find the pane's terminal through the
 * KELPI_PANE_ID every process in it inherits, then read the directory of the terminal's
 * foreground process: the shell at a prompt, or whatever program is running in it.
 *
 * Finding the terminal means reading process environments, so it is kept as narrow as the OS
 * allows: only your own processes that have a terminal, only once per pane (the answer is
 * cached, and so is a failure), and only the KELPI_PANE_ID marker is looked at. Nothing else
 * is kept or logged.
 *
 * A program started in the pane can pass the marker on to terminals of its own (a tmux server
 * does), so the pane's terminal is the one holding the OLDEST marked process: its shell.
 */
const paneTTYs = new Map();   // paneID -> tty name (macOS) or tty number (Linux)
const paneMisses = new Map(); // paneID -> time until which the pane is not scanned again

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
function elapsedSeconds(etime) {
    const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
    return clock.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86400;
}

async function darwinTTYForPane(paneID) {
    // Without -x, ps lists only your processes that have a controlling terminal.
    const output = await run(PS, ['-E', '-ww', '-o', 'tty=,etime=,command=']);
    const marker = `KELPI_PANE_ID=${paneID}`;
    let best = null;
    for (const line of output.split('\n')) {
        const index = line.indexOf(marker);
        if (index === -1) continue;
        const after = line[index + marker.length];
        if ((after !== undefined && after !== ' ') || line[index - 1] !== ' ') continue;
        const [tty, etime] = line.trim().split(/\s+/, 2);
        if (!tty || tty === '??' || !etime) continue;
        const age = elapsedSeconds(etime);
        if (!best || age > best.age) best = { tty, age };
    }
    return best?.tty ?? null;
}

/**
 * The cwd of the terminal's foreground process group leader, else of its shell (when the
 * foreground program belongs to someone else, as under sudo). `empty` means no process is
 * left on the terminal, so a cached terminal is stale.
 */
async function darwinForegroundCwd(tty) {
    const output = await run(PS, ['-x', '-o', 'pid=,ppid=,tpgid=', '-t', tty]);
    const rows = output.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row[0] > 0);
    if (!rows.length) return { status: 'empty' };
    const pids = new Set(rows.map(([pid]) => pid));
    const tpgid = rows[0][2];
    const shell = rows.find(([, ppid]) => !pids.has(ppid))?.[0];
    const candidates = [...new Set([pids.has(tpgid) ? tpgid : null, shell].filter(Boolean))];
    if (!candidates.length) return { status: 'unreadable' };
    let lsof = '';
    try { lsof = await run(LSOF, ['-a', '-p', candidates.join(','), '-d', 'cwd', '-Fpn']); }
    catch (error) { lsof = typeof error?.stdout === 'string' ? error.stdout : ''; }
    const cwds = new Map();
    let pid = null;
    for (const line of lsof.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1));
    }
    for (const candidate of candidates) if (cwds.has(candidate)) return { status: 'ok', cwd: cwds.get(candidate) };
    return { status: 'unreadable' };
}

const procStat = async pid => {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // Fields after the command name: state ppid pgrp session tty_nr tpgid ... starttime is 20th.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { session: Number(fields[3]), tty: Number(fields[4]), tpgid: Number(fields[5]), start: Number(fields[19]) };
};

async function linuxTTYForPane(paneID) {
    const marker = Buffer.from(`KELPI_PANE_ID=${paneID}\0`);
    let best = null;
    for (const name of await fsp.readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            // Check for a terminal first, so daemons and services never have their environment read.
            const stat = await procStat(name);
            if (!(stat.tty > 0)) continue;
            const environ = await fsp.readFile(`/proc/${name}/environ`);
            if (environ.includes(marker) && (!best || stat.start < best.start)) best = { tty: String(stat.tty), start: stat.start };
        } catch { /* exited or not ours */ }
    }
    return best?.tty ?? null;
}

async function linuxForegroundCwd(ttyNumber) {
    let leader = null;
    let shell = null;
    let any = false;
    for (const name of await fsp.readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = await procStat(name);
            if (String(stat.tty) !== ttyNumber) continue;
            any = true;
            if (Number(name) === stat.tpgid) leader = name;
            if (Number(name) === stat.session) shell = name;
        } catch { /* exited or not ours */ }
    }
    if (!any) return { status: 'empty' };
    for (const pid of [leader, shell]) {
        if (!pid) continue;
        try { return { status: 'ok', cwd: await fsp.readlink(`/proc/${pid}/cwd`) }; } catch { /* not ours */ }
    }
    return { status: 'unreadable' };
}

const ttyForPane = process.platform === 'darwin' ? darwinTTYForPane : process.platform === 'linux' ? linuxTTYForPane : async () => null;
const foregroundCwd = process.platform === 'darwin' ? darwinForegroundCwd : process.platform === 'linux' ? linuxForegroundCwd : async () => ({ status: 'empty' });

async function isDirectory(dir) {
    try { return (await fsp.stat(dir)).isDirectory(); } catch { return false; }
}

async function resolveCwd({ paneID, fallback = null }) {
    const fallbackPath = typeof fallback === 'string' && path.isAbsolute(fallback) ? fallback : null;
    const kelpi = { cwd: fallbackPath, source: 'kelpi' };
    if (typeof paneID !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(paneID)) return kelpi;
    if ((paneMisses.get(paneID) ?? 0) > Date.now()) return kelpi;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            let tty = paneTTYs.get(paneID);
            const cached = tty !== undefined;
            if (!cached) {
                tty = await ttyForPane(paneID);
                if (!tty) break;
                remember(paneTTYs, paneID, tty, 256);
            }
            const result = await foregroundCwd(tty);
            if (result.status === 'ok') return await isDirectory(result.cwd) ? { cwd: result.cwd, source: 'process' } : kelpi;
            // Someone else's program in the foreground: keep the terminal, fall back for now.
            if (result.status === 'unreadable') return kelpi;
            // Nothing left on the terminal: the cached one is stale, so look it up again once.
            paneTTYs.delete(paneID);
            if (!cached) break;
        }
    } catch {
        paneTTYs.delete(paneID);
    }
    remember(paneMisses, paneID, Date.now() + PANE_MISS_TTL_MS, 256);
    return kelpi;
}

// --- File operations -------------------------------------------------------------------------

/** Folders whose listings an operation changed, so the view reloads them without waiting. */
const touchedBy = paths => [...new Set(paths.map(item => path.dirname(item)))];

async function create({ dir, name, kind }) {
    const result = await createItem({ dir, name, kind });
    for (const folder of touchedBy([result.undo])) queueChange(folder, path.basename(result.undo));
    return result;
}

async function move({ pairs }) {
    const result = await moveItems(pairs);
    for (const { from, to } of result.moved) { queueChange(path.dirname(from)); queueChange(path.dirname(to), path.basename(to)); }
    return result;
}

async function duplicate({ path: target }) {
    const result = await duplicateItem({ path: target });
    queueChange(path.dirname(result.path), path.basename(result.path));
    return result;
}

async function trash({ paths }) {
    if (!Array.isArray(paths) || !paths.length) throw new Error('nothing to move to the Trash');
    const targets = [...new Set(paths.map(absolute))];
    // Trashing a folder takes everything in it; listing an item inside it too would fail.
    const outermost = targets.filter(item => !targets.some(other => other !== item && isWithin(item, other)));
    for (const item of outermost) if (item === path.parse(item).root || item === os.homedir()) throw new Error('That folder can\'t be moved to the Trash from here.');
    const results = await moveToTrash(outermost);
    for (const folder of touchedBy(outermost)) queueChange(folder);
    return { trashed: results };
}

/** Puts trashed items back where they were, never over something that has taken their place. */
async function restore({ items }) {
    if (!Array.isArray(items) || !items.length) throw new Error('nothing to restore');
    const pairs = items.map(item => ({ from: absolute(item?.to), to: absolute(item?.from) }));
    const result = await moveItems(pairs);
    for (const { from } of result.moved) await forgetTrashRecord(from).catch(() => {});
    for (const { to } of result.moved) queueChange(path.dirname(to), path.basename(to));
    return { restored: result.moved.map(pair => pair.to) };
}

// --- File details ----------------------------------------------------------------------------

const EXECUTABLE_MAGIC = [
    [0x7f, 0x45, 0x4c, 0x46],   // ELF
    [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], // Mach-O
    [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],   // Mach-O universal, Java class
    [0x4d, 0x5a],               // Windows PE
];

/** The first `bytes` of a regular file, without ever blocking on a fifo. */
async function readHead(file, bytes) {
    let handle;
    try {
        // O_NONBLOCK so a file that turns into a fifo between stat and open cannot hang a thread.
        handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle?.close();
    }
}

function looksLikeText(chunk) {
    if (chunk.includes(0)) return false;
    // A multi-byte character may be cut at the end of the sample; ignore the last 3 bytes.
    try { new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, Math.max(0, chunk.length - 3))); return true; }
    catch { return false; }
}

/**
 * What kind of file this is, so the view can route it: `regular` is false for fifos, sockets
 * and devices (opening those would block), `text` decides editor versus default app, and
 * `executable` keeps a plain Open from running a program.
 */
async function sniff({ path: target }) {
    const file = absolute(target);
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) return { regular: false, text: false, executable: false };
        const chunk = await readHead(file, 4096);
        const magic = EXECUTABLE_MAGIC.some(bytes => bytes.every((byte, index) => chunk[index] === byte));
        const executable = magic || (process.platform !== 'win32' && (stat.mode & 0o111) !== 0 && !chunk.subarray(0, 2).equals(Buffer.from('#!')));
        return { regular: true, text: looksLikeText(chunk) && !magic, executable };
    } catch (error) {
        return { regular: false, text: false, executable: false, error: describeError(error) };
    }
}

/** Details for the hover card: size, dates, and the first lines of a text file. */
async function preview({ path: target, showHidden = true }) {
    const file = absolute(target);
    let stat;
    try { stat = await fsp.stat(file); }
    catch (error) { return { exists: false, error: describeError(error) }; }
    const details = { exists: true, size: stat.isFile() ? stat.size : null, mtimeMs: Math.round(stat.mtimeMs), birthtimeMs: Math.round(stat.birthtimeMs) || null, mode: stat.mode & 0o7777 };
    if (stat.isDirectory()) return { ...details, kind: 'folder', count: await countChildren(file, showHidden) };
    if (!stat.isFile()) return { ...details, kind: 'other' };
    let chunk;
    try { chunk = await readHead(file, PREVIEW_BYTES); }
    catch (error) { return { ...details, kind: 'file', error: describeError(error) }; }
    if (!looksLikeText(chunk)) return { ...details, kind: 'file', binary: true };
    const lines = chunk.toString('utf8').replace(/�$/, '').split(/\r?\n/);
    const complete = stat.size <= PREVIEW_BYTES;
    // Without the whole file, the last line may be cut short; drop it.
    if (!complete && lines.length > 1) lines.pop();
    // A final newline is not a line of its own.
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return {
        ...details, kind: 'file', binary: false,
        lines: lines.slice(0, PREVIEW_LINES).map(line => line.length > PREVIEW_LINE_LENGTH ? `${line.slice(0, PREVIEW_LINE_LENGTH)}…` : line),
        more: !complete || lines.length > PREVIEW_LINES,
    };
}

// --- OS actions ------------------------------------------------------------------------------

function copy({ text }) {
    if (typeof text !== 'string') throw new Error('text is required');
    const candidates = process.platform === 'darwin' ? [['pbcopy', []]]
        : process.platform === 'win32' ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    const attempt = index => new Promise((resolve, reject) => {
        if (index >= candidates.length) { reject(new Error('No clipboard command is available.')); return; }
        const [file, args] = candidates[index];
        // A failed spawn emits both `error` and `close`; act on the first only.
        let settled = false;
        const next = () => { if (!settled) { settled = true; attempt(index + 1).then(resolve, reject); } };
        const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', next);
        child.on('close', code => {
            if (code === 0 && !settled) { settled = true; resolve({ copied: true }); } else next();
        });
        // Writing to a process that never started raises EPIPE on stdin; that must not crash the backend.
        child.stdin.on('error', () => {});
        child.stdin.end(text);
    });
    return attempt(0);
}

async function openExternal({ path: target }) {
    const file = absolute(target);
    const [command, args] = process.platform === 'darwin' ? ['open', [file]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]];
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', reject);
        child.on('spawn', () => { child.unref(); resolve(); });
    });
    return { opened: true };
}

function info() {
    return { home: os.homedir(), platform: process.platform, separator: path.sep };
}

// --- Commands --------------------------------------------------------------------------------

/**
 * Commands only reach a File Tree that is on screen: the view does the work, and a hidden
 * view holds no watch lease. Each one becomes a `command` event the view acts on.
 */
export const COMMANDS = ['focus', 'search', 'search-content', 'reveal', 'new-file', 'new-folder', 'collapse-all', 'refresh', 'toggle-hidden', 'toggle-ignored', 'toggle-pin', 'undo'];

/** @param {import('@kelpi/plugin-sdk').BackendAPI} api */
export async function activate(api) {
    emitEvent = (name, data) => { void api.emit(name, data).catch(() => {}); };
    const sweep = setInterval(reconcileWatchers, 15000);
    sweep.unref?.();
    const gitTick = setInterval(() => git.tick(watchedDirs()), 2500);
    gitTick.unref?.();
    const disposers = [api.providers.register(PROVIDER_ID, {
        info, resolveCwd, list, search, grep, watch, release, copy, sniff, preview, openExternal,
        create, move, duplicate, trash, restore,
    })];
    for (const action of COMMANDS) {
        disposers.push(api.commands.register(`${PLUGIN_ID}.${action}`, async (_args, context) => {
            if (!hasLiveView()) throw new Error('Show File Tree in a sidebar first: Settings → Plugins → Workbench views.');
            await api.emit('command', { action, paneID: context?.paneID ?? null, workspaceID: context?.workspaceID ?? null });
            return null;
        }));
    }
    return () => {
        for (const dispose of disposers) dispose();
        clearInterval(sweep);
        clearInterval(gitTick);
        clearTimeout(changeTimer);
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
        leases.clear();
        git.close();
    };
}
