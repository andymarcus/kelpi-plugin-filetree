/**
 * File Tree backend: filesystem access for the sidebar view.
 *
 * The view runs in a sandboxed iframe with no filesystem, so everything that touches the disk
 * or the OS lives here and is exposed as the `andymarcus.filetree.fs@1` service. Replies stay
 * well under Kelpi's 256 KiB JSON envelope: listings use compact tuples and are truncated, and
 * search ranks on this side so the index never crosses the bridge.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const PROVIDER_ID = 'andymarcus.filetree.fs.node';

// Listing limits. Rows are measured in UTF-8 bytes so a reply stays inside the envelope.
const MAX_LIST_ENTRIES = 3000;
const LIST_BYTE_BUDGET = 180 * 1024;
// Child counts need one readdir per folder; skip them for very wide directories.
const MAX_COUNTED_FOLDERS = 400;
const COUNT_CACHE_LIMIT = 4000;
const STAT_CONCURRENCY = 48;

// Search limits. Folders in PRUNE are listed but never descended into, so a single
// node_modules cannot exhaust the index before the project's own files are reached.
const MAX_INDEX_ENTRIES = 60000;
const INDEX_TIME_BUDGET_MS = 4000;
const INDEX_TTL_MS = 30000;
// A busy folder marks the index dirty constantly; rebuild it at most this often.
const INDEX_MIN_REBUILD_MS = 3000;
const INDEX_CACHE_LIMIT = 3;
const MAX_RESULTS = 200;
const MAX_MATCH_LENGTH = 1024;
const PRUNE = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', 'Pods', 'DerivedData']);

// Watch leases: views renew every 15 s; a lease that is not renewed lapses.
const LEASE_MS = 45000;
const MAX_WATCHED_DIRS = 512;
const CHANGE_DEBOUNCE_MS = 120;

// Pane directory lookups: a pane whose terminal cannot be found is not scanned again for this long.
const PANE_MISS_TTL_MS = 30000;

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
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('an absolute path is required');
    return path.resolve(value);
};

const isWithin = (child, base) => base === path.sep || child === base || child.startsWith(base + path.sep);

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

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isFolderKind = kind => kind === 'd' || kind === 'L';

// --- Listing -------------------------------------------------------------------------------

/**
 * Entry kinds: d folder, f file, L symlink to a folder, l symlink to a file,
 * b broken symlink, o anything else (socket, fifo, device, or a link to one).
 * Only symlinks cost a syscall here; sizes are read later for the rows actually shown.
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

async function sizeOf(full, kind) {
    try {
        if (kind === 'f') return (await fsp.lstat(full)).size;
        if (kind === 'l') return (await fsp.stat(full)).size;
    } catch { /* vanished between readdir and stat */ }
    return null;
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

async function list({ path: target, showHidden = true }) {
    const dir = absolute(target);
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { return { path: dir, error: describeError(error), code: error?.code ?? null }; }

    if (!showHidden) dirents = dirents.filter(dirent => !dirent.name.startsWith('.'));
    const kinds = await mapLimit(dirents, STAT_CONCURRENCY, dirent => kindOf(dir, dirent));
    const all = dirents.map((dirent, index) => ({ name: dirent.name, kind: kinds[index] }));
    all.sort((a, b) => (isFolderKind(b.kind) - isFolderKind(a.kind)) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));

    const shown = all.slice(0, MAX_LIST_ENTRIES);
    await mapLimit(shown, STAT_CONCURRENCY, async entry => { entry.size = await sizeOf(path.join(dir, entry.name), entry.kind); });
    const folders = shown.filter(entry => isFolderKind(entry.kind));
    if (folders.length <= MAX_COUNTED_FOLDERS) {
        await mapLimit(folders, STAT_CONCURRENCY, async entry => { entry.count = await countChildren(path.join(dir, entry.name), showHidden); });
    }

    const entries = [];
    let bytes = 0;
    for (const entry of shown) {
        const row = [entry.name, entry.kind, entry.size ?? null, entry.count ?? null];
        bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        if (bytes > LIST_BYTE_BUDGET) break;
        entries.push(row);
    }
    return { path: dir, entries, total: all.length };
}

// --- Fuzzy search ----------------------------------------------------------------------------

// `${root}\0${hidden}` -> { root, index, builtAt, building, dirty }, least recently used first.
const indexes = new Map();

async function buildIndex(root, showHidden) {
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

async function indexFor(root, showHidden) {
    const key = `${root}\0${showHidden}`;
    const entry = indexes.get(key) ?? { root, index: null, builtAt: 0, building: null, dirty: false };
    remember(indexes, key, entry, INDEX_CACHE_LIMIT);
    if (entry.building) return entry.building;
    const age = Date.now() - entry.builtAt;
    if (entry.index && age < INDEX_TTL_MS && (!entry.dirty || age < INDEX_MIN_REBUILD_MS)) return entry.index;
    // Clear the mark before building, so a change made during the build marks it again.
    entry.dirty = false;
    entry.building = buildIndex(root, showHidden).then(
        index => { entry.index = index; entry.builtAt = Date.now(); entry.building = null; return index; },
        error => { entry.building = null; throw error; });
    return entry.building;
}

function markIndexesDirty(dir) {
    for (const entry of indexes.values()) if (isWithin(dir, entry.root)) entry.dirty = true;
}

// fzy's scoring: rewards matches after separators, capitals and consecutive runs.
const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MATCH_BASENAME = 1.0;

/** Lower-cases one UTF-16 unit at a time, so indexes into the result match the original. */
function fold(text) {
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

function isSubsequence(needle, haystack) {
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

function fuzzyScore(needle, text, lowerText) {
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

async function search({ root: target, query = '', showHidden = true }) {
    const root = absolute(target);
    const index = await indexFor(root, showHidden);
    const needle = fold(String(query).replace(/\s+/g, '')).slice(0, 64);
    let results;
    if (!needle) {
        results = index.entries.slice(0, MAX_RESULTS).map(([relative, isDir]) => [relative, isDir, []]);
    } else {
        const scored = [];
        for (const [relative, isDir] of index.entries) {
            if (relative.length > MAX_MATCH_LENGTH) continue;
            const lower = fold(relative);
            if (!isSubsequence(needle, lower)) continue;
            const { score, positions } = fuzzyScore(needle, relative, lower);
            // Prefer entries whose own name holds the end of the match over ones matched by a parent.
            const nameBonus = positions[positions.length - 1] > relative.lastIndexOf('/') ? SCORE_MATCH_BASENAME : 0;
            scored.push({ relative, isDir, score: score + nameBonus, positions });
        }
        scored.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length || collator.compare(a.relative, b.relative));
        results = scored.slice(0, MAX_RESULTS).map(item => [item.relative, item.isDir, item.positions]);
    }
    return { root, results, indexed: index.entries.length, truncated: index.truncated };
}

// --- Watching --------------------------------------------------------------------------------

const leases = new Map();   // token -> { dirs: Set<string>, expires: number }, oldest first
const watchers = new Map(); // dir -> FSWatcher
const pendingChanges = new Set();
let changeTimer = null;
let emitChange = () => {};

function queueChange(dir) {
    pendingChanges.add(dir);
    markIndexesDirty(dir);
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
        changeTimer = null;
        const dirs = [...pendingChanges];
        pendingChanges.clear();
        emitChange(dirs);
    }, CHANGE_DEBOUNCE_MS);
}

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
            const watcher = fs.watch(dir, { persistent: false }, () => queueChange(dir));
            watcher.on('error', () => {
                watcher.close();
                watchers.delete(dir);
                // The folder itself went away: its parent's listing is what changed.
                queueChange(dir);
                queueChange(path.dirname(dir));
            });
            watchers.set(dir, watcher);
        } catch {
            // Unreadable or vanished; the view shows the listing error instead.
        }
    }
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

const EXECUTABLE_MAGIC = [
    [0x7f, 0x45, 0x4c, 0x46],   // ELF
    [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], // Mach-O
    [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],   // Mach-O universal, Java class
    [0x4d, 0x5a],               // Windows PE
];

/**
 * What kind of file this is, so the view can route it: `regular` is false for fifos, sockets
 * and devices (opening those would block), `text` decides editor versus default app, and
 * `executable` keeps a plain Open from running a program.
 */
async function sniff({ path: target }) {
    const file = absolute(target);
    let handle;
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) return { regular: false, text: false, executable: false };
        // O_NONBLOCK so a file that turns into a fifo between stat and open cannot hang a thread.
        handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const chunk = buffer.subarray(0, bytesRead);
        const magic = EXECUTABLE_MAGIC.some(bytes => bytes.every((byte, index) => chunk[index] === byte));
        const executable = magic || (process.platform !== 'win32' && (stat.mode & 0o111) !== 0 && !chunk.subarray(0, 2).equals(Buffer.from('#!')));
        let text = !chunk.includes(0);
        if (text) {
            // A multi-byte character may be cut at the end of the sample; ignore the last 3 bytes.
            try { new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, Math.max(0, chunk.length - 3))); }
            catch { text = false; }
        }
        return { regular: true, text: text && !magic, executable };
    } catch (error) {
        return { regular: false, text: false, executable: false, error: describeError(error) };
    } finally {
        await handle?.close();
    }
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

/** @param {import('@kelpi/plugin-sdk').BackendAPI} api */
export async function activate(api) {
    emitChange = dirs => { void api.emit('changed', { dirs }).catch(() => {}); };
    const sweep = setInterval(reconcileWatchers, 15000);
    sweep.unref?.();
    const offProvider = api.providers.register(PROVIDER_ID, {
        info, resolveCwd, list, search, watch, release, copy, sniff, openExternal,
    });
    return () => {
        offProvider();
        clearInterval(sweep);
        clearTimeout(changeTimer);
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
        leases.clear();
    };
}
