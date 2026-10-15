/**
 * Git status for the folders the tree shows. One `git status` per repository answers every
 * row in it: the result is cached, refreshed when the worktree or `.git` changes (and on a slow
 * timer, for changes in folders nobody is watching), and turned into one code per row.
 *
 * git runs with GIT_OPTIONAL_LOCKS=0, so a status never takes the index lock and can't make
 * the user's own git commands fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SEVERITY, parseStatus } from './git.mjs';

const STATUS_TIMEOUT_MS = 15000;
const REPO_TTL_MS = 30000;
const REPO_CACHE_LIMIT = 256;
const TRACKED_REPO_LIMIT = 8;
const MAX_STATUS_ENTRIES = 50000;
const REFRESH_DEBOUNCE_MS = 250;
// A repository is re-checked at least this often while it is on screen, so changes inside
// collapsed folders (which are not watched) still show up.
const PERIODIC_MIN_MS = 5000;

const isWithin = (child, base) => child === base || child.startsWith(base + path.sep);

let gitBinary;
/** git, without ever running macOS's /usr/bin/git stub, which offers to install Xcode tools. */
export async function findGit() {
    if (gitBinary !== undefined) return gitBinary;
    for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git']) {
        if (fs.existsSync(candidate)) return (gitBinary = candidate);
    }
    if (process.platform !== 'darwin') return (gitBinary = 'git');
    const developerTools = await new Promise(resolve => {
        execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
    });
    return (gitBinary = developerTools && fs.existsSync(path.join(developerTools, 'usr', 'bin', 'git')) ? '/usr/bin/git' : null);
}

async function git(args, cwd) {
    const binary = await findGit();
    if (!binary) throw Object.assign(new Error('git is not installed'), { code: 'NOGIT' });
    return new Promise((resolve, reject) => {
        execFile(binary, args, {
            cwd, timeout: STATUS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

/** Ancestors of a relative path, nearest first: `a/b/c` -> `a/b`, `a`. */
function* ancestors(relative) {
    for (let at = relative.lastIndexOf('/'); at > 0; at = relative.lastIndexOf('/', at - 1)) yield relative.slice(0, at);
}

/** Lookups built once per status: exact codes, collapsed folders, and per-folder summaries. */
export function indexStatus(parsed) {
    const exact = new Map();     // relative path -> code
    const collapsed = new Map(); // relative folder git reported as a whole (`?` or `!`) -> code
    const folders = new Map();   // relative folder -> most severe change inside it
    const deleted = new Map();   // relative folder ('' for the top) -> names deleted from it
    let changed = 0;
    // A rename's old path is gone too, but it shows as the renamed file, not as a deletion.
    for (const [raw, code] of parsed.entries) {
        const isFolder = raw.endsWith('/');
        const relative = isFolder ? raw.slice(0, -1) : raw;
        exact.set(relative, code);
        if (isFolder) collapsed.set(relative, code);
        if (code === '!') continue;
        changed++;
        for (const folder of ancestors(relative)) {
            const current = folders.get(folder);
            if (current === undefined || SEVERITY[code] > SEVERITY[current]) folders.set(folder, code);
        }
        if (code === 'D') {
            const slash = relative.lastIndexOf('/');
            const parent = slash === -1 ? '' : relative.slice(0, slash);
            if (!deleted.has(parent)) deleted.set(parent, []);
            deleted.get(parent).push(relative.slice(slash + 1));
        }
    }
    return { exact, collapsed, folders, deleted, changed };
}

export class GitTracker {
    constructor(onChange) {
        this.onChange = onChange;  // (top) => void, when a repository's status changed
        this.repoOf = new Map();   // folder -> { top, gitDir } | null, with `at`
        this.repos = new Map();    // top -> state, least recently used first
    }

    /** The repository holding `dir`, or null. Cached, including the misses. */
    async repoFor(dir) {
        const cached = this.repoOf.get(dir);
        if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.repo;
        let repo = null;
        try {
            const [top, gitDir] = (await git(['rev-parse', '--show-toplevel', '--absolute-git-dir'], dir)).toString('utf8').trim().split('\n');
            if (top && gitDir) repo = { top: path.resolve(top), gitDir: path.resolve(gitDir) };
        } catch { /* not a repository, or git is missing */ }
        this.repoOf.delete(dir);
        this.repoOf.set(dir, { repo, at: Date.now() });
        while (this.repoOf.size > REPO_CACHE_LIMIT) this.repoOf.delete(this.repoOf.keys().next().value);
        return repo;
    }

    state(repo) {
        let state = this.repos.get(repo.top);
        if (state) { this.repos.delete(repo.top); }
        else state = { ...repo, status: null, raw: null, running: null, dirty: true, timer: null, checkedAt: 0, duration: 0, watcher: null, error: null, owed: false };
        this.repos.set(repo.top, state);
        while (this.repos.size > TRACKED_REPO_LIMIT) this.drop(this.repos.keys().next().value);
        return state;
    }

    drop(top) {
        const state = this.repos.get(top);
        if (!state) return;
        clearTimeout(state.timer);
        state.watcher?.close();
        this.repos.delete(top);
    }

    /** The current status of `repo`, computing it when it is missing or out of date. */
    async status(repo) {
        const state = this.state(repo);
        if (state.status && !state.dirty) return state.status;
        return this.refresh(state);
    }

    /**
     * The cached status, or null; never waits for git. A caller that got null answered without
     * git, so the first status to arrive is announced even though nothing changed.
     */
    cached(repo) {
        const state = this.repos.get(repo.top);
        if (state && !state.status) state.owed = true;
        return state?.status ?? null;
    }

    refresh(state) {
        if (state.running) return state.running;
        state.dirty = false;
        const started = Date.now();
        state.running = git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching'], state.top)
            .then(output => {
                const changed = state.raw === null ? state.owed : !output.equals(state.raw);
                state.owed = false;
                state.raw = output;
                const parsed = parseStatus(output, MAX_STATUS_ENTRIES);
                state.status = { top: state.top, branch: parsed.branch, truncated: parsed.truncated, ...indexStatus(parsed) };
                state.error = null;
                return { changed };
            }, error => {
                state.error = error;
                return { changed: false };
            })
            .then(({ changed }) => {
                state.duration = Date.now() - started;
                state.checkedAt = Date.now();
                state.running = null;
                if (changed && this.repos.get(state.top) === state) this.onChange(state.top);
                // Something changed while git was running: look again.
                if (state.dirty) this.schedule(state);
                if (!state.status) throw state.error ?? new Error('git status failed');
                return state.status;
            });
        return state.running;
    }

    schedule(state, delay = REFRESH_DEBOUNCE_MS) {
        state.dirty = true;
        if (state.timer || state.running) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            if (this.repos.get(state.top) === state) void this.refresh(state).catch(() => {});
        }, delay);
        state.timer.unref?.();
    }

    /** A folder in the worktree changed on disk. */
    touched(dir) {
        for (const state of this.repos.values()) {
            // Changes inside .git itself come through the .git watcher.
            if (isWithin(dir, state.top) && !isWithin(dir, state.gitDir)) this.schedule(state);
        }
    }

    /**
     * Keeps `.git` watched for the repositories that hold a watched folder, and forgets the
     * others' watchers. Commits, staging and checkouts change `.git`, not the worktree.
     */
    reconcile(watchedDirs) {
        for (const state of this.repos.values()) {
            const wanted = watchedDirs.some(dir => isWithin(dir, state.top));
            if (wanted && !state.watcher) {
                try {
                    const watcher = fs.watch(state.gitDir, { persistent: false, recursive: process.platform === 'darwin' }, (_event, name) => {
                        // Object writes alone change nothing a status shows.
                        if (typeof name === 'string' && (name.startsWith('objects') || name.endsWith('.lock'))) return;
                        this.schedule(state);
                    });
                    watcher.on('error', () => { watcher.close(); if (state.watcher === watcher) state.watcher = null; });
                    state.watcher = watcher;
                } catch { /* unreadable; the periodic check still runs */ }
            } else if (!wanted && state.watcher) {
                state.watcher.close();
                state.watcher = null;
            }
        }
    }

    /** The slow timer: re-check repositories on screen that haven't been checked for a while. */
    tick(watchedDirs) {
        for (const state of this.repos.values()) {
            if (!state.watcher || !watchedDirs.some(dir => isWithin(dir, state.top))) continue;
            const interval = Math.max(PERIODIC_MIN_MS, state.duration * 10);
            if (!state.running && Date.now() - state.checkedAt >= interval) void this.refresh(state).catch(() => {});
        }
    }

    close() {
        for (const top of [...this.repos.keys()]) this.drop(top);
    }
}

/** The code to show for `relative` (own, or from a collapsed folder above it), or null. */
export function codeOf(status, relative) {
    const own = status.exact.get(relative);
    if (own !== undefined) return own;
    for (const folder of ancestors(relative)) {
        const code = status.collapsed.get(folder);
        if (code !== undefined) return code;
    }
    return null;
}

/** What a folder row shows: its own code, else the most severe change inside it. */
export function folderCodeOf(status, relative) {
    const own = codeOf(status, relative);
    if (own === '!' || own === '?') return own;
    return status.folders.get(relative) ?? own;
}
