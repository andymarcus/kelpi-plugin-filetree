/* File Tree sidebar. Shows the folder of the focused Kelpi pane and follows it as you move
   between panes or `cd` around. Build-free: Kelpi is reached through the injected
   window.kelpi API, and the disk through this plugin's own andymarcus.filetree.fs service. */
(() => {
    const api = window.kelpi;
    const { categoryFor, openRoute, extensionOf, isRunnable, icon } = window.FileCategories;
    const {
        join, parentOf, basename, isWithin, relativeTo, CONTROL_CHARACTERS, printable, safeRelative, shellQuote, fileURL,
        editorCommand, humanSize, itemCount, relativeTime, GIT_LABELS, GIT_BADGES, outermost, SORT_LABELS, SORTS, nextSort,
    } = window.FileTreeUtil;

    const PLUGIN = 'andymarcus.filetree';
    const SERVICE = `${PLUGIN}.fs`;
    const PROVIDER = `${PLUGIN}.fs.node`;
    const PREFS_KEY = 'prefs';
    const ROW_HEIGHT = 22;
    const INDENT = 12;
    const OVERSCAN = 8;
    const NARROW_WIDTH = 230;
    // Polling for `cd` in a terminal starts fast and backs off while the folder stays put.
    const POLL_BACKOFF = 1.5;
    const POLL_SLOW_MIN_MS = 6000;
    const WATCH_RENEW_MS = 15000;
    const LOADING_GRACE_MS = 150;
    const ROOT_MEMORY_LIMIT = 24;
    const UNDO_LIMIT = 30;
    const PEEK_DELAY_MS = 650;
    const DRAG_EXPAND_MS = 700;
    // Panes whose folder is worth following. Web, scratchpad and plugin panes keep the last root.
    const FOLLOWED_TYPES = new Set(['shell', 'markdown', 'csv', 'diff']);
    // Panes whose own file can be selected in the tree.
    const DOCUMENT_TYPES = new Set(['markdown', 'csv', 'diff']);
    const CHANGE_CODES = new Set(['M', 'A', 'D', 'R', 'U']);

    // Must match kelpi.plugin.json; settings.get fills in what the user has changed.
    const DEFAULT_SETTINGS = Object.freeze({
        showHidden: true, sort: 'name', foldersFirst: true, exclude: '.DS_Store, Thumbs.db', hoverPreview: true, highlightSeconds: 8,
        gitStatus: true, hideIgnored: false, followActiveFile: true, confirmTrash: true, editor: '', followInterval: 1.5,
    });
    // Settings that change what a listing holds, so every folder is listed again.
    const LISTING_SETTINGS = new Set(['showHidden', 'sort', 'foldersFirst', 'exclude', 'gitStatus', 'hideIgnored']);

    const $ = id => document.getElementById(id);
    const tree = $('tree');
    const spacer = $('spacer');
    const resultsBox = $('results');
    const searchInput = $('search-input');
    const editBox = $('edit');
    const editInput = $('edit-input');
    const fsCall = (method, args = {}) => api.services.call(SERVICE, 1, method, args, { provider: PROVIDER });
    const message = cause => cause instanceof Error ? cause.message : String(cause);
    const escapeHTML = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
    const isMac = () => platform === 'darwin';
    const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    // --- State ----------------------------------------------------------------------------
    let settings = { ...DEFAULT_SETTINGS };
    let prefs = { pinnedRoot: null, bookmarks: [], regex: false };
    let platform = 'darwin';
    let home = '';
    let root = null;
    let source = null;           // { workspaceID, paneID, type, agent, title, fallback, cwd, filePath }
    let shellPaneID = null;      // last focused terminal in the active workspace
    let panesByID = new Map();   // snapshot panes of the active workspace
    let navigation = null;
    let remoteActive = false;
    let backendError = null;
    let visible = api.visible !== false;
    let disposed = false;

    const dirs = new Map();      // folder path -> { status, entries, total, error, seq, startedAt, repo }
    let loadSeq = 0;             // shared, so a reply from before a root change can never match
    let expanded = new Set();
    let selected = null;         // the cursor row's path
    let marked = new Set();      // multi-selection; empty means "just the cursor row"
    let anchor = null;           // where a Shift range starts
    let rows = [];
    let rowIndexByPath = new Map();
    let pendingScrollTop = null;
    const rootMemory = new Map();
    const recent = new Map();    // path -> when it changed on disk

    let searchOpen = false;
    let searchMode = 'files';    // 'files' | 'content'
    let searchResults = [];      // files: { relative, isDir, positions }; content: items, see renderContentResults
    let searchRoot = null;       // the root the current results are relative to
    let resultIndex = 0;
    let searchSeq = 0;
    let searchTimer = null;

    let pointerDown = false;
    let renderQueued = false;
    let renderAfterPointer = false;
    let sourceResolved = false;
    let loadingTimer = null;
    let toastTimer = null;
    let menuState = null;
    let editing = null;          // inline create or rename, see startCreate / startRename
    let dialogState = null;
    let drag = null;             // { paths, target, expandTimer } while dragging rows
    const history = [];          // undo stack: { label, run }
    const watchToken = crypto.randomUUID();
    let watchKey = '';
    const disposers = [];

    // --- Paths ----------------------------------------------------------------------------
    const displayPath = path => printable(!path ? '' : home && isWithin(path, home) ? (path === home ? '~' : `~/${relativeTo(path, home)}`) : path);
    const assertTypable = path => {
        if (CONTROL_CHARACTERS.test(path)) throw new Error('This name contains control characters, so it is not sent to a terminal. Copy the path instead.');
    };
    const revealLabel = () => isMac() ? 'Reveal in Finder' : 'Reveal in File Manager';
    const paneTitle = pane => (pane?.label || pane?.title || '').replace(/^[^\p{L}\p{N}]+\s*/u, '').trim();
    const quoted = name => `“${printable(name)}”`;

    // --- Theme and layout -----------------------------------------------------------------
    function applyTone() {
        const value = getComputedStyle(document.documentElement).getPropertyValue('--kelpi-bg').trim()
            || getComputedStyle(document.documentElement).getPropertyValue('--kelpi-surface').trim();
        const probe = document.createElement('span');
        probe.style.color = value || '#101013';
        document.body.append(probe);
        const match = getComputedStyle(probe).color.match(/[\d.]+/g);
        probe.remove();
        if (!match) return;
        const [r, g, b] = match.map(Number).map(channel => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        document.documentElement.dataset.tone = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? 'light' : 'dark';
    }

    const isNarrow = () => document.body.clientWidth < NARROW_WIDTH;
    new ResizeObserver(() => {
        document.body.classList.toggle('narrow', isNarrow());
        queueRender();
        hidePeek();
    }).observe(document.body);

    // --- Feedback -------------------------------------------------------------------------
    /** A short message; `action` adds a button (Undo) and keeps it up longer. */
    function toast(text, { action = null } = {}) {
        const box = $('toast');
        $('toast-text').textContent = text;
        const button = $('toast-action');
        button.hidden = !action;
        if (action) { button.textContent = action.label; button.onclick = () => { box.hidden = true; run(action.run); }; }
        box.hidden = false;
        box.style.animation = 'none';
        void box.offsetWidth;
        box.style.animation = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { box.hidden = true; }, action ? 5000 : 1800);
    }
    const fail = cause => toast(message(cause));

    function updateHeader() {
        $('root-name').textContent = root ? printable(basename(root)) : 'File Tree';
        $('root-path').innerHTML = root ? `<bdi>${escapeHTML(displayPath(root))}</bdi>` : '';
        $('root-path').title = root ?? '';
        const pinned = Boolean(prefs.pinnedRoot);
        $('btn-pin').setAttribute('aria-pressed', String(pinned));
        $('btn-pin').setAttribute('aria-label', pinned ? 'Unpin and follow the focused pane' : 'Pin this folder');
        $('btn-pin').title = pinned ? 'Unpin: follow the focused pane  (p)' : 'Pin this folder  (p)';
        $('pin-badge').hidden = !pinned;
        const bookmarked = Boolean(root && prefs.bookmarks.includes(root));
        $('btn-bookmarks').setAttribute('aria-pressed', String(bookmarked));
        updateStatus();
    }

    function updateStatus() {
        const node = root ? dirs.get(root) : null;
        const parts = [];
        if (prefs.pinnedRoot) parts.push('Pinned');
        else if (remoteActive) parts.push('Remote workspace: showing the last local folder');
        else if (source) parts.push(`Following ${paneTitle(source) || (source.type === 'shell' ? 'terminal' : source.type)}`);
        if (node?.status === 'ready') parts.push(itemCount(node.total));
        if (marked.size > 1) parts.push(`${marked.size} selected`);
        $('status').textContent = parts.join('  ·  ');
        updateBranch(node?.repo ?? null);
    }

    function updateBranch(repo) {
        const button = $('branch');
        if (!repo || repo.pending || !settings.gitStatus) { button.hidden = true; return; }
        const name = repo.branch ?? (repo.oid ? `detached ${repo.oid}` : 'no commits');
        const sync = `${repo.ahead ? ` ↑${repo.ahead}` : ''}${repo.behind ? ` ↓${repo.behind}` : ''}`;
        button.innerHTML = `${icon('branch')}<span class="branch-name"></span>${sync ? `<span class="branch-sync">${escapeHTML(sync.trim())}</span>` : ''}` +
            (repo.changed ? `<span class="branch-changes">${repo.changed}${repo.truncated ? '+' : ''}</span>` : '');
        button.querySelector('.branch-name').textContent = printable(name);
        const details = [`Branch ${name}`];
        if (repo.upstream) details.push(`Tracking ${repo.upstream}${repo.ahead || repo.behind ? ` (${repo.ahead} ahead, ${repo.behind} behind)` : ''}`);
        details.push(repo.changed ? `${repo.changed}${repo.truncated ? '+' : ''} changed file${repo.changed === 1 ? '' : 's'}: click to open the changes` : 'No changes');
        button.title = details.join('\n');
        button.classList.toggle('clean', !repo.changed);
        button.dataset.top = repo.top;
        button.hidden = false;
    }

    function showState({ glyph = 'alert', title, detail = '', action = null } = {}) {
        if (!title) { $('state').hidden = true; return; }
        $('state-icon').innerHTML = icon(glyph);
        $('state-title').textContent = title;
        $('state-detail').textContent = detail;
        $('state-action').hidden = !action;
        if (action) { $('state-action').textContent = action.label; $('state-action').onclick = action.run; }
        $('state').hidden = false;
    }

    function updateState() {
        if (searchOpen) { showState(); return; }
        if (backendError) {
            showState({ title: 'File Tree could not start', detail: backendError, action: { label: 'Try again', run: () => { backendError = null; void boot(); } } });
            return;
        }
        if (!root) {
            if (!sourceResolved) { showState(); return; }
            showState(source === null && !remoteActive
                ? { glyph: 'terminal', title: 'No folder to show', detail: 'Focus a terminal pane and its folder appears here.' }
                : { glyph: 'terminal', title: 'Finding your folder…' });
            return;
        }
        const node = dirs.get(root);
        if (node?.status === 'error') {
            showState({ title: 'Can\'t open this folder', detail: node.error, action: { label: 'Try again', run: () => void load(root) } });
        } else if (node?.status === 'ready' && node.entries.length === 0 && !(editing?.mode === 'create' && editing.dir === root)) {
            const hidden = [!settings.showHidden && 'Hidden', settings.hideIgnored && 'git-ignored'].filter(Boolean);
            showState({ glyph: 'folder', title: 'This folder is empty', detail: hidden.length ? `${hidden.join(' and ')} files are not shown.` : '' });
        } else {
            showState();
        }
    }

    // --- Settings -------------------------------------------------------------------------
    function normalizeSettings(raw) {
        const next = { ...DEFAULT_SETTINGS };
        for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
            if (raw && typeof raw[key] === typeof fallback) next[key] = raw[key];
        }
        if (!SORTS.includes(next.sort)) next.sort = 'name';
        return next;
    }

    /** Applies a setting here at once, and saves it (Kelpi echoes it back as settings.changed). */
    function setSetting(key, value) {
        applySettings({ ...settings, [key]: value });
        void api.settings.set(key, value).catch(fail);
    }

    function applySettings(next) {
        const before = settings;
        settings = normalizeSettings(next);
        const changed = Object.keys(DEFAULT_SETTINGS).filter(key => before[key] !== settings[key]);
        if (!changed.length) return;
        if (changed.some(key => LISTING_SETTINGS.has(key))) {
            // Folders under collapsed parents would show stale listings when opened again.
            const onScreen = new Set([root, ...rows.filter(row => row.open).map(row => row.path)]);
            for (const dir of [...dirs.keys()]) if (!onScreen.has(dir)) dirs.delete(dir);
            reloadAll();
            if (searchOpen) runSearch(searchInput.value, 0);
        }
        if (changed.includes('followInterval')) pollSoon();
        if (changed.includes('hoverPreview')) hidePeek();
        if (changed.includes('highlightSeconds')) queueRender(true);
        updateHeader();
        updateState();
    }

    function savePrefs() {
        void api.storage.set(PREFS_KEY, prefs).catch(() => {});
    }

    // --- Following the focused pane -------------------------------------------------------
    let snapshotTimer = null;
    let sourceSeq = 0;
    let cwdSeq = 0;

    function scheduleSourceRefresh(delay = 60) {
        if (snapshotTimer || disposed) return;
        snapshotTimer = setTimeout(() => { snapshotTimer = null; void refreshSource().catch(fail); }, delay);
    }

    function activeWorkspaceID(state) {
        const local = navigation?.hosts.find(host => host.kind === 'local');
        const active = navigation?.active;
        if (active && local) return active.hostID === local.id ? active.workspaceID : undefined;
        return api.context.workspaceID ?? state.lastActiveWorkspaceID ?? null;
    }

    async function refreshSource() {
        const seq = ++sourceSeq;
        const snapshot = await api.snapshot();
        if (seq !== sourceSeq || disposed) return;
        const workspaceID = activeWorkspaceID(snapshot.state);
        remoteActive = workspaceID === undefined;
        if (remoteActive) { updateHeader(); updateState(); return; }

        const workspace = snapshot.state.workspaces.find(item => item.id === workspaceID);
        const panes = workspace?.panes ?? [];
        panesByID = new Map(panes.map(pane => [pane.id, pane]));
        const focused = panes.find(pane => pane.id === workspace?.focusedPaneID) ?? null;
        if (focused?.type === 'shell') shellPaneID = focused.id;
        else if (!panesByID.has(shellPaneID ?? '')) shellPaneID = panes.find(pane => pane.type === 'shell')?.id ?? null;

        if (focused && FOLLOWED_TYPES.has(focused.type)) {
            const previous = source?.paneID === focused.id ? source : null;
            const fallback = focused.workingDirectory || null;
            const filePath = DOCUMENT_TYPES.has(focused.type) && typeof focused.filePath === 'string' && focused.filePath.startsWith('/') ? focused.filePath : null;
            // Title and status updates arrive constantly; only a new pane or a new Kelpi directory
            // needs a lookup now. A `cd` Kelpi doesn't see is the poll's job.
            const needsLookup = !previous || previous.fallback !== fallback || previous.cwd === null;
            const newFile = filePath && (!previous || previous.filePath !== filePath);
            source = {
                workspaceID, paneID: focused.id, type: focused.type, agent: focused.agentKind ?? null,
                title: focused.title, label: focused.label, fallback, cwd: previous?.cwd ?? null, filePath,
            };
            if (needsLookup) await resolveSourceCwd();
            else updateHeader();
            if (newFile && settings.followActiveFile && root && isWithin(filePath, root)) await revealPath(filePath, { flash: false });
        } else if (!focused) {
            source = null;
            updateHeader();
            updateState();
        } else {
            updateHeader();
        }
    }

    async function resolveSourceCwd() {
        const current = source;
        if (!current) return;
        const seq = ++cwdSeq;
        let cwd = current.fallback;
        if (current.type === 'shell') {
            const result = await fsCall('resolveCwd', { paneID: current.paneID, fallback: current.fallback });
            cwd = result?.cwd ?? current.fallback;
        }
        if (seq !== cwdSeq || disposed || source !== current) return false;
        const changed = current.cwd !== cwd;
        current.cwd = cwd;
        if (!prefs.pinnedRoot && cwd && cwd !== root) setRoot(cwd);
        updateHeader();
        updateState();
        if (changed) pollSoon();
        return changed;
    }

    /** Selects the file (or folder) of a pane: the focused one, or the one a pane menu named. */
    async function revealPane(paneID = null) {
        if (paneID && paneID !== source?.paneID) await refreshSource();
        const pane = panesByID.get(paneID ?? source?.paneID ?? '') ?? null;
        const target = (DOCUMENT_TYPES.has(pane?.type) && typeof pane.filePath === 'string' && pane.filePath)
            || (pane?.id === source?.paneID ? source?.cwd : null) || pane?.workingDirectory || null;
        if (!target) { toast('This pane has no file to reveal.'); return; }
        if (!root || !isWithin(target, root)) {
            if (prefs.pinnedRoot) { toast('That file is outside the pinned folder.'); return; }
            setRoot(DOCUMENT_TYPES.has(pane?.type) ? parentOf(target) : target);
        }
        focusTree();
        if (target !== root) await revealPath(target);
    }

    // --- Adaptive polling -----------------------------------------------------------------
    let pollTimer = null;
    let pollDelay = 1500;
    const pollFast = () => Math.round(settings.followInterval * 1000);
    const pollSlow = () => Math.max(POLL_SLOW_MIN_MS, pollFast() * 4);
    const pollWanted = () => visible && !prefs.pinnedRoot && !disposed;

    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = pollWanted() ? setTimeout(pollOnce, pollDelay) : null;
    }

    /** Activity (a new pane, a moved folder, files changing): check quickly again. */
    function pollSoon() {
        pollDelay = pollFast();
        schedulePoll();
    }

    async function pollOnce() {
        pollTimer = null;
        let changed = false;
        if (pollWanted() && source?.type === 'shell') {
            try { changed = await resolveSourceCwd(); } catch { /* next poll retries */ }
        }
        pollDelay = changed ? pollFast() : Math.min(pollSlow(), Math.round(pollDelay * POLL_BACKOFF));
        schedulePoll();
    }

    // --- Listing --------------------------------------------------------------------------
    function rememberRoot() {
        if (!root) return;
        rootMemory.delete(root);
        rootMemory.set(root, { expanded: [...expanded], selected, scrollTop: tree.scrollTop });
        while (rootMemory.size > ROOT_MEMORY_LIMIT) rootMemory.delete(rootMemory.keys().next().value);
    }

    function setRoot(next) {
        if (next === root) return;
        rememberRoot();
        cancelEdit();
        hidePeek();
        root = next;
        const memory = rootMemory.get(next);
        expanded = new Set((memory?.expanded ?? []).filter(path => isWithin(path, next)));
        expanded.add(next);
        selected = memory?.selected ?? null;
        marked = new Set();
        anchor = null;
        pendingScrollTop = memory?.scrollTop ?? 0;
        for (const path of dirs.keys()) if (!isWithin(path, next)) dirs.delete(path);
        updateHeader();
        rebuild();
        for (const dir of expanded) void load(dir);
        if (searchOpen) runSearch(searchInput.value, 0);
    }

    const listArgs = dir => ({
        path: dir, root, showHidden: settings.showHidden, hideIgnored: settings.hideIgnored, sort: settings.sort,
        foldersFirst: settings.foldersFirst, exclude: settings.exclude, gitStatus: settings.gitStatus,
    });

    async function load(dir) {
        const current = dirs.get(dir);
        const seq = ++loadSeq;
        const ready = current?.status === 'ready';
        dirs.set(dir, {
            entries: ready ? current.entries : [], total: ready ? current.total : 0, repo: ready ? current.repo : null,
            status: ready ? 'ready' : 'loading', error: null, seq, startedAt: Date.now(),
        });
        if (!ready) scheduleLoadingRebuild();
        let next;
        try {
            const result = await fsCall('list', listArgs(dir));
            next = result.error
                ? { status: 'error', error: result.error, entries: [], total: 0, repo: null }
                : {
                    status: 'ready', error: null, total: result.total, repo: result.repo ?? null,
                    entries: result.entries.map(([name, kind, size, count, mtime, git]) => ({ name, kind, size, count, mtime, git: git ?? null, path: join(dir, name) })),
                };
        } catch (cause) {
            next = { status: 'error', error: message(cause), entries: [], total: 0, repo: null };
        }
        const latest = dirs.get(dir);
        if (disposed || !latest || latest.seq !== seq) return;
        dirs.set(dir, { ...next, seq });
        rebuild();
        if (dir === root) { updateState(); updateStatus(); }
        syncWatch();
    }

    function scheduleLoadingRebuild() {
        clearTimeout(loadingTimer);
        loadingTimer = setTimeout(rebuild, LOADING_GRACE_MS + 10);
    }

    /** Reloads the root and every open folder that is on screen (not ones under a collapsed parent). */
    function reloadAll() {
        if (!root) return;
        for (const dir of [root, ...rows.filter(row => row.open).map(row => row.path)]) void load(dir);
    }

    // --- Rows -----------------------------------------------------------------------------
    function rebuild() {
        const next = [];
        const now = Date.now();
        const editRow = depth => ({ edit: true, depth, isDir: editing.kind === 'folder', name: '', key: '\0edit', path: null });
        const walk = (dir, depth) => {
            const node = dirs.get(dir);
            if (editing?.mode === 'create' && editing.dir === dir) next.push(editRow(depth));
            if (!node || (node.status === 'loading' && node.entries.length === 0)) {
                if (depth > 0 && node && now - node.startedAt >= LOADING_GRACE_MS) next.push({ note: true, depth, text: 'Loading…', key: `${dir}\0loading` });
                return;
            }
            if (node.status === 'error') {
                if (depth > 0) next.push({ note: true, error: true, depth, text: node.error, key: `${dir}\0error` });
                return;
            }
            for (const entry of node.entries) {
                const isDir = entry.kind === 'd' || entry.kind === 'L';
                const open = isDir && expanded.has(entry.path);
                next.push({ ...entry, depth, isDir, open, key: entry.path, inRepo: Boolean(node.repo) });
                if (open) walk(entry.path, depth + 1);
            }
            if (node.total > node.entries.length) {
                next.push({ note: true, depth, text: `${node.total - node.entries.length} more items not shown`, key: `${dir}\0more` });
            }
        };
        if (root) walk(root, 0);
        rows = next;
        rowIndexByPath = new Map();
        rows.forEach((row, index) => { if (row.path) rowIndexByPath.set(row.path, index); });
        if (selected && !rowIndexByPath.has(selected) && !isLoadingAncestor(selected)) selected = null;
        for (const path of marked) if (!rowIndexByPath.has(path) && !isLoadingAncestor(path)) marked.delete(path);
        if (pendingScrollTop !== null && root && dirs.get(root)?.status === 'ready') {
            tree.scrollTop = pendingScrollTop;
            pendingScrollTop = null;
        }
        queueRender();
        syncWatch();
    }

    // Keep a selection whose folder is still loading, so it survives a refresh.
    function isLoadingAncestor(path) {
        for (let dir = parentOf(path); root && isWithin(dir, root); dir = parentOf(dir)) {
            if (dirs.get(dir)?.status === 'loading') return true;
            if (dir === root || dir === '/') break;
        }
        return false;
    }

    function queueRender(force = false) {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            // Replacing rows under a pressed pointer would swallow its click.
            if (pointerDown && !force) { renderAfterPointer = true; return; }
            render();
        });
    }

    function render() {
        if (searchOpen) return;
        spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
        const top = tree.scrollTop;
        const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
        const end = Math.min(rows.length, Math.ceil((top + tree.clientHeight) / ROW_HEIGHT) + OVERSCAN);
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) fragment.append(rowElement(rows[index], index));
        spacer.replaceChildren(fragment);
        syncActiveDescendant();
        placeEditBox();
    }

    const isMarked = path => marked.size ? marked.has(path) : path === selected;

    function recentStyle(path) {
        const seconds = settings.highlightSeconds;
        const at = recent.get(path);
        if (!at || seconds <= 0) return null;
        const elapsed = Date.now() - at;
        if (elapsed >= seconds * 1000) return null;
        return `--recent-duration:${seconds}s;--recent-delay:-${elapsed}ms`;
    }

    function rowElement(row, index) {
        const element = document.createElement('div');
        element.className = 'row';
        element.style.top = `${index * ROW_HEIGHT}px`;
        element.style.paddingLeft = `calc(var(--gutter) + ${row.depth * INDENT}px)`;
        element.dataset.index = String(index);
        if (row.depth) {
            const guides = document.createElement('span');
            guides.className = 'guides';
            guides.style.width = `${row.depth * INDENT}px`;
            element.append(guides);
        }
        if (row.note) {
            element.classList.add('note');
            if (row.error) element.classList.add('error');
            element.insertAdjacentHTML('beforeend', `<span class="twisty"></span><span class="icon">${row.error ? icon('alert') : ''}</span><span class="name"></span>`);
            element.querySelector('.name').textContent = row.text;
            element.setAttribute('role', 'none');
            return element;
        }
        if (row.edit) {
            const glyph = row.isDir ? 'folder' : 'default';
            element.classList.add('editing');
            element.insertAdjacentHTML('beforeend', `<span class="twisty">${row.isDir ? icon('chevron') : ''}</span><span class="icon cat-${row.isDir ? 'folder' : 'default'}">${icon(glyph)}</span>`);
            element.setAttribute('role', 'none');
            return element;
        }
        const category = categoryFor(row.name, row.isDir);
        const iconName = row.isDir ? (row.open ? 'folderOpen' : 'folder') : category;
        element.id = `row-${index}`;
        element.setAttribute('role', 'treeitem');
        element.setAttribute('aria-level', String(row.depth + 1));
        element.setAttribute('aria-selected', String(isMarked(row.path)));
        if (row.path === selected) element.classList.add('cursor');
        if (row.isDir) { element.setAttribute('aria-expanded', String(row.open)); element.classList.add('folder'); }
        if (row.kind === 'L' || row.kind === 'l') element.classList.add('link');
        if (row.kind === 'b') element.classList.add('broken');
        if (row.kind === 'x') element.classList.add('deleted');
        if (row.git === '!') element.classList.add('ignored');
        if (drag?.target === row.path) element.classList.add('drop-target');
        const style = recentStyle(row.path);
        if (style) { element.classList.add('recent'); element.style.cssText += style; }
        element.draggable = row.kind !== 'x';
        const meta = row.kind === 'x' ? '' : row.isDir ? itemCount(row.count) : humanSize(row.size);
        const code = settings.gitStatus ? row.git : null;
        // Rows in a repository keep the badge's slot even without one, so sizes line up.
        const git = !code || code === '!' ? (settings.gitStatus && row.inRepo ? '<span class="git" aria-hidden="true"></span>' : '')
            : row.isDir ? `<span class="git-dot git-${gitClass(code)}" title="${escapeHTML(folderGitTitle(code))}"></span>`
            : `<span class="git git-${gitClass(code)}" title="${escapeHTML(GIT_LABELS[code])}">${escapeHTML(GIT_BADGES[code])}</span>`;
        element.insertAdjacentHTML('beforeend',
            `<span class="twisty">${row.isDir ? icon('chevron') : ''}</span>` +
            `<span class="icon cat-${category}">${icon(iconName)}</span>` +
            `<span class="name cat-${category}"></span>` +
            (row.kind === 'L' || row.kind === 'l' || row.kind === 'b' ? `<span class="link-mark" title="Symbolic link">${icon('link')}</span>` : '') +
            `<span class="end">${meta ? `<span class="meta">${escapeHTML(meta)}</span>` : ''}${git}</span>`);
        element.querySelector('.name').textContent = printable(row.name);
        element.title = displayPath(row.path) + (code && code !== '!' && !row.isDir ? `  ·  ${GIT_LABELS[code]}` : code === '!' ? '  ·  Ignored by git' : '');
        return element;
    }

    // CSS class names can't hold `?` or `!`.
    const gitClass = code => ({ '?': 'untracked', '!': 'ignored' }[code] ?? code);
    const folderGitTitle = code => code === '?' ? 'Untracked folder' : code === 'U' ? 'Has conflicts inside' : code === 'D' ? 'Has deletions inside' : 'Has changes inside';

    function syncActiveDescendant() {
        const index = selected ? rowIndexByPath.get(selected) : undefined;
        const element = index === undefined ? null : document.getElementById(`row-${index}`);
        if (element) tree.setAttribute('aria-activedescendant', element.id);
        else tree.removeAttribute('aria-activedescendant');
    }

    function syncSelection() {
        for (const element of spacer.querySelectorAll('.row[role="treeitem"]')) {
            const path = rows[Number(element.dataset.index)]?.path;
            element.setAttribute('aria-selected', String(isMarked(path)));
            element.classList.toggle('cursor', path === selected);
        }
        syncActiveDescendant();
        updateStatus();
    }

    function select(path, { reveal = true, keepMarks = false } = {}) {
        selected = path;
        if (!keepMarks) { marked = new Set(); anchor = path; }
        syncSelection();
        if (reveal) ensureVisible(rowIndexByPath.get(path));
    }

    function ensureVisible(index) {
        if (index === undefined) return;
        const top = index * ROW_HEIGHT;
        const padding = 4;
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (top + ROW_HEIGHT + padding * 2 > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + ROW_HEIGHT + padding * 2 - tree.clientHeight;
        queueRender(true);
    }

    const selectedRow = () => { const index = selected ? rowIndexByPath.get(selected) : undefined; return index === undefined ? null : rows[index]; };
    const realRows = () => rows.filter(row => row.path && !row.note && !row.edit);

    /** The rows an action applies to: the marked ones in tree order, else the cursor row. */
    function targets() {
        if (marked.size) return realRows().filter(row => marked.has(row.path));
        const row = selectedRow();
        return row ? [row] : [];
    }

    /** Marks every row between the anchor and `path`, for Shift-click and Shift-arrows. */
    function markRange(path) {
        const list = realRows();
        const from = list.findIndex(row => row.path === (anchor ?? selected ?? path));
        const to = list.findIndex(row => row.path === path);
        if (to === -1) return;
        const [start, end] = from === -1 ? [to, to] : from < to ? [from, to] : [to, from];
        marked = new Set(list.slice(start, end + 1).map(row => row.path));
        if (marked.size === 1) marked = new Set();
        selected = path;
        syncSelection();
        ensureVisible(rowIndexByPath.get(path));
    }

    function toggleMark(path) {
        if (!marked.size && selected && selected !== path) marked.add(selected);
        if (marked.has(path)) marked.delete(path); else marked.add(path);
        selected = path;
        anchor = path;
        if (marked.size === 1) { selected = [...marked][0]; marked = new Set(); }
        syncSelection();
    }

    function selectAll() {
        const list = realRows();
        if (!list.length) return;
        marked = new Set(list.map(row => row.path));
        selected ??= list[0].path;
        anchor = selected;
        syncSelection();
    }

    function clearMarks() {
        if (!marked.size) return false;
        marked = new Set();
        syncSelection();
        return true;
    }

    // --- Recent changes -------------------------------------------------------------------
    let recentSweep = null;
    function noteChanged(files) {
        if (settings.highlightSeconds <= 0 || !root) return;
        const now = Date.now();
        for (const file of files) if (typeof file === 'string' && isWithin(file, root) && file !== root) recent.set(file, now);
        if (!recentSweep && recent.size) {
            recentSweep = setInterval(() => {
                const cutoff = Date.now() - settings.highlightSeconds * 1000;
                for (const [path, at] of recent) if (at < cutoff) recent.delete(path);
                if (!recent.size) { clearInterval(recentSweep); recentSweep = null; }
            }, 2000);
        }
    }

    // --- Folder actions -------------------------------------------------------------------
    function toggle(row, open = !row.open) {
        if (!row?.isDir) return;
        if (open) {
            expanded.add(row.path);
            rebuild();
            void load(row.path);
        } else {
            expanded.delete(row.path);
            rebuild();
        }
    }

    function collapseAll() {
        expanded = new Set(root ? [root] : []);
        if (selected && root && parentOf(selected) !== root) selected = null;
        marked = new Set();
        tree.scrollTop = 0;
        rebuild();
    }

    function moveSelection(delta, { extend = false } = {}) {
        if (!rows.length) return;
        let index = selected ? rowIndexByPath.get(selected) ?? -1 : -1;
        if (index === -1) index = delta > 0 ? -1 : rows.length;
        let next = Math.max(0, Math.min(rows.length - 1, index + delta));
        const step = delta > 0 ? 1 : -1;
        const skip = row => row?.note || row?.edit;
        while (skip(rows[next]) && next + step >= 0 && next + step < rows.length) next += step;
        while (skip(rows[next]) && next - step >= 0 && next - step < rows.length) next -= step;
        const row = rows[next];
        if (!row || skip(row)) return;
        if (extend) { anchor ??= selected ?? row.path; markRange(row.path); }
        else select(row.path);
    }

    async function revealPath(target, { flash = true } = {}) {
        if (!root || !isWithin(target, root)) return;
        const chain = [];
        for (let dir = parentOf(target); isWithin(dir, root) && dir !== root; dir = parentOf(dir)) chain.unshift(dir);
        await ensureLoaded(root);
        for (const dir of chain) {
            expanded.add(dir);
            await ensureLoaded(dir);
        }
        rebuild();
        if (!rowIndexByPath.has(target)) return;
        select(target);
        const index = rowIndexByPath.get(target);
        const top = index * ROW_HEIGHT;
        if (top < tree.scrollTop || top + ROW_HEIGHT > tree.scrollTop + tree.clientHeight) tree.scrollTop = Math.max(0, top - tree.clientHeight / 2);
        render();
        if (flash) document.getElementById(`row-${index}`)?.classList.add('drop-flash');
    }

    async function ensureLoaded(dir) {
        if (dirs.get(dir)?.status !== 'ready') await load(dir);
    }

    function focusTree() {
        try { window.focus(); } catch { /* not allowed from here */ }
        if (searchOpen) closeSearch();
        tree.focus({ preventScroll: true });
    }

    // --- Opening and terminal actions -----------------------------------------------------
    function anchorPaneID() {
        return source?.paneID ?? shellPaneID ?? null;
    }

    function terminalTarget() {
        if (source?.type === 'shell' && panesByID.has(source.paneID)) return source.paneID;
        return shellPaneID;
    }

    async function open(row, { raw = false, line = null } = {}) {
        if (row.isDir) { toggle(row); return; }
        if (row.kind === 'x') { await openChanges(row.path); return; }
        if (row.kind === 'b') { toast('This link points to nothing.'); return; }
        // Fifos, sockets and devices: opening one would block whatever reads it.
        if (row.kind === 'o') { toast('This is not a regular file, so it is not opened.'); return; }
        let route = openRoute(row.name);
        if (raw || line) {
            const textual = ['.md', '.markdown', '.csv', '.tsv', '.html', '.htm', '.svg'].includes(extensionOf(row.name));
            route = route === 'text' || textual ? 'text' : route === 'unknown' ? 'unknown' : 'external';
        }
        if (route === 'unknown' || route === 'external') {
            const kind = await fsCall('sniff', { path: row.path });
            if (!kind.regular) { toast(kind.error ?? 'This is not a regular file, so it is not opened.'); return; }
            if (route === 'unknown') route = kind.text ? 'text' : 'external';
            // Never run a program from a plain Open; that stays an explicit menu choice.
            if (route === 'external' && (kind.executable || isRunnable(row.name))) {
                await reveal(row.path);
                toast(`Revealed ${printable(row.name)} instead of running it`);
                return;
            }
        }
        const anchorID = anchorPaneID();
        if (route === 'kelpi') {
            await api.files.open(row.path, { ...(anchorID ? { paneID: anchorID } : {}), focus: true });
        } else if (route === 'web') {
            const reply = await api.command({ command: 'web-open', url: fileURL(row.path), focus: true, ...(anchorID ? { pane_id: anchorID } : {}) });
            if (reply?.ok === false) throw new Error(reply.error ?? 'Kelpi could not open this file.');
        } else if (route === 'text') {
            await openInEditor(row.path, line);
        } else {
            await fsCall('openExternal', { path: row.path });
            toast(`Opened ${printable(row.name)}`);
        }
    }

    async function openInEditor(path, line = null) {
        assertTypable(path);
        const anchorID = terminalTarget() ?? anchorPaneID();
        if (!anchorID) throw new Error('Open a terminal pane first.');
        const split = await api.panes.split(anchorID, { direction: 'horizontal', path: parentOf(path), focus: true });
        await api.terminal.send(split.paneID, editorCommand(path, line, settings.editor.trim()));
    }

    async function openTerminalAt(dir) {
        const anchorID = anchorPaneID();
        if (anchorID) await api.panes.split(anchorID, { direction: 'horizontal', path: dir, focus: true });
        else await api.panes.create({ path: dir, focus: true });
    }

    /** The repository top for a path in the tree, from the listing of the folder holding it. */
    function repoTopFor(path) {
        for (let dir = path; root && isWithin(dir, root); dir = parentOf(dir)) {
            const top = dirs.get(dir)?.repo?.top;
            if (top) return top;
            if (dir === root) break;
        }
        return null;
    }

    /** Opens Kelpi's diff pane for a file, a folder, or (no path) the whole repository. */
    async function openChanges(path = null, top = path ? repoTopFor(path) : $('branch').dataset.top) {
        if (!top) { toast('This is not in a git repository.'); return; }
        const anchorID = anchorPaneID();
        const reply = await api.command({ command: 'diff', repo_path: top, ...(path && path !== top ? { target_path: path } : {}), ...(anchorID ? { pane_id: anchorID } : {}) });
        if (reply?.ok === false) throw new Error(reply.error ?? 'Kelpi could not open the changes.');
    }

    async function insertPaths(paths) {
        const target = terminalTarget();
        if (!target) throw new Error('There is no terminal pane to insert into.');
        paths.forEach(assertTypable);
        const pane = panesByID.get(target);
        const cwd = target === source?.paneID ? source.cwd : null;
        const claude = pane?.agentKind === 'claude';
        const words = paths.map(path => {
            const shown = cwd && isWithin(path, cwd) && path !== cwd ? safeRelative(relativeTo(path, cwd)) : path;
            return claude && !/\s/.test(shown) ? `@${shown}` : shellQuote(shown);
        });
        await api.terminal.send(target, `${words.join(' ')} `, { bare: true });
        const workspaceID = source?.workspaceID ?? api.context.workspaceID;
        if (workspaceID) await api.ui.focusPane(workspaceID, target).catch(() => {});
    }

    async function copyText(text, label) {
        await fsCall('copy', { text });
        toast(label);
    }

    const copyPaths = (paths, relative = false) => copyText(
        paths.map(path => relative ? relativeTo(path, root) : path).join('\n'),
        `Copied ${relative ? 'relative ' : ''}path${paths.length === 1 ? '' : `s (${paths.length})`}`);

    async function reveal(path) {
        await api.files.reveal(path, { select: true });
    }

    function setPinned(path) {
        prefs = { ...prefs, pinnedRoot: path };
        savePrefs();
        if (path) setRoot(path);
        updateHeader();
        if (!path) {
            toast('Following the focused pane');
            if (source?.cwd && source.cwd !== root) setRoot(source.cwd);
            void resolveSourceCwd().catch(fail);
            pollSoon();
        } else {
            schedulePoll();
        }
    }

    function toggleHidden() {
        setSetting('showHidden', !settings.showHidden);
        toast(settings.showHidden ? 'Showing hidden files' : 'Hiding hidden files');
    }

    function toggleIgnored() {
        setSetting('hideIgnored', !settings.hideIgnored);
        toast(settings.hideIgnored ? 'Hiding git-ignored files' : 'Showing git-ignored files');
    }

    function cycleSort() {
        setSetting('sort', nextSort(settings.sort));
        toast(`Sorted by ${SORT_LABELS[settings.sort].toLowerCase()}`);
    }

    function toggleBookmark(path) {
        if (!path) return;
        const has = prefs.bookmarks.includes(path);
        prefs = { ...prefs, bookmarks: has ? prefs.bookmarks.filter(item => item !== path) : [...prefs.bookmarks, path].slice(-50) };
        savePrefs();
        updateHeader();
        toast(has ? `Removed ${quoted(basename(path))} from bookmarks` : `Bookmarked ${quoted(basename(path))}`);
    }

    const run = action => { void Promise.resolve().then(action).catch(fail); };

    // --- Undo -----------------------------------------------------------------------------
    function pushUndo(label, undo) {
        history.push({ label, run: undo });
        if (history.length > UNDO_LIMIT) history.shift();
    }

    async function undoLast() {
        const entry = history.pop();
        if (!entry) { toast('Nothing to undo'); return; }
        try {
            await entry.run();
            toast(`Undid ${entry.label}`);
        } catch (cause) {
            toast(`Couldn't undo ${entry.label}: ${message(cause)}`);
        }
    }

    // --- File operations ------------------------------------------------------------------
    const dirForNew = () => {
        const row = selectedRow();
        if (!row || row.edit || row.note) return root;
        return row.isDir && row.kind !== 'x' ? row.path : parentOf(row.path);
    };

    /** Opens an inline name box at the top of `dir` for a new file or folder. */
    async function startCreate(kind, dir = dirForNew()) {
        if (!root || !dir) return;
        if (searchOpen) closeSearch();
        cancelEdit();
        hidePeek();
        // A folder opened just to hold the name box closes again if the box is cancelled.
        const opened = dir !== root && !expanded.has(dir);
        if (opened) expanded.add(dir);
        await ensureLoaded(dir);
        editing = { mode: 'create', kind, dir, original: '', opened };
        rebuild();
        updateState();
        openEditBox('', kind === 'folder' ? 'New folder name' : 'New file name (a/b.txt makes folders too)');
    }

    function startRename(row) {
        if (!row || row.note || row.edit || row.kind === 'x') return;
        cancelEdit();
        hidePeek();
        editing = { mode: 'rename', kind: row.isDir ? 'folder' : 'file', path: row.path, original: row.name };
        select(row.path);
        openEditBox(row.name, 'New name');
        // Select the name without its extension, as Finder does.
        const dot = row.isDir ? -1 : row.name.lastIndexOf('.');
        editInput.setSelectionRange(0, dot > 0 ? dot : row.name.length);
    }

    function openEditBox(value, label) {
        editInput.value = value;
        editInput.setAttribute('aria-label', label);
        editInput.placeholder = editing.mode === 'create' ? (editing.kind === 'folder' ? 'Folder name' : 'File name') : '';
        $('edit-error').hidden = true;
        editBox.hidden = false;
        render();
        editInput.focus({ preventScroll: true });
        editInput.select();
    }

    function placeEditBox() {
        if (!editing) { editBox.hidden = true; return; }
        const index = editing.mode === 'create' ? rows.findIndex(row => row.edit) : rowIndexByPath.get(editing.path);
        if (index === undefined || index === -1) { editBox.hidden = true; return; }
        const row = rows[index];
        editBox.hidden = false;
        editBox.style.top = `${spacer.offsetTop + index * ROW_HEIGHT}px`;
        // Over the name: gutter, indent, twisty (14 + 2) and icon (15 + 6), less the input's padding.
        editBox.style.left = `calc(var(--gutter) + ${row.depth * INDENT + 16 + 21 - 4}px)`;
    }

    function cancelEdit() {
        if (!editing) return;
        const wasCreate = editing.mode === 'create';
        if (wasCreate && editing.opened) expanded.delete(editing.dir);
        editing = null;
        editBox.hidden = true;
        if (wasCreate) { rebuild(); updateState(); }
        if (document.activeElement === editInput) tree.focus({ preventScroll: true });
    }

    function showEditError(text) {
        const box = $('edit-error');
        box.textContent = text;
        box.hidden = false;
    }

    let committing = false;
    async function commitEdit({ fromBlur = false } = {}) {
        if (!editing || committing) return;
        const value = editInput.value;
        const current = editing;
        if (!value.trim() || value === current.original) {
            // Leaving an empty or unchanged box is a cancel, not an error.
            cancelEdit();
            return;
        }
        committing = true;
        try {
            if (current.mode === 'create') await createFromEdit(current, value);
            else await renameFromEdit(current, value);
        } catch (cause) {
            if (fromBlur) { cancelEdit(); fail(cause); }
            else { showEditError(message(cause)); editInput.focus(); }
        } finally {
            committing = false;
        }
    }

    async function createFromEdit(current, value) {
        const result = await fsCall('create', { dir: current.dir, name: value, kind: current.kind });
        editing = null;
        editBox.hidden = true;
        tree.focus({ preventScroll: true });
        // List the folders on the way down now, rather than waiting for the watcher.
        const chain = [];
        for (let dir = parentOf(result.path); isWithin(dir, current.dir); dir = parentOf(dir)) { chain.push(dir); if (dir === current.dir) break; }
        await Promise.all(chain.filter(dir => dir === current.dir || dirs.has(dir)).map(load));
        await revealPath(result.path, { flash: false });
        updateState();
        const label = `new ${current.kind} ${quoted(basename(result.path))}`;
        pushUndo(label, async () => { await fsCall('trash', { paths: [result.undo] }); });
        toast(`Created ${quoted(basename(result.path))}`, { action: { label: 'Undo', run: undoLast } });
    }

    async function renameFromEdit(current, value) {
        if (value.includes('/')) throw new Error('A name can\'t contain "/". Drag the item to move it.');
        const to = join(parentOf(current.path), value);
        await fsCall('move', { pairs: [{ from: current.path, to }] });
        editing = null;
        editBox.hidden = true;
        tree.focus({ preventScroll: true });
        remapPaths(current.path, to);
        await load(parentOf(to));
        await revealPath(to, { flash: false });
        const label = `rename to ${quoted(value)}`;
        pushUndo(label, async () => {
            await fsCall('move', { pairs: [{ from: to, to: current.path }] });
            remapPaths(to, current.path);
            await load(parentOf(current.path));
            await revealPath(current.path, { flash: false });
        });
        toast(`Renamed to ${quoted(value)}`, { action: { label: 'Undo', run: undoLast } });
    }

    /** Keeps open folders, selection and highlights attached to items that moved. */
    function remapPaths(from, to) {
        const move = path => path === from ? to : isWithin(path, from) ? to + path.slice(from.length) : path;
        expanded = new Set([...expanded].map(move));
        marked = new Set([...marked].map(move));
        if (selected) selected = move(selected);
        for (const dir of [...dirs.keys()]) if (isWithin(dir, from)) dirs.delete(dir);
        for (const dir of expanded) if (isWithin(dir, to) && !dirs.has(dir)) void load(dir);
    }

    async function duplicate(row) {
        if (!row || row.kind === 'x') return;
        const result = await fsCall('duplicate', { path: row.path });
        await load(parentOf(result.path));
        await revealPath(result.path, { flash: false });
        pushUndo(`duplicate ${quoted(row.name)}`, async () => { await fsCall('trash', { paths: [result.path] }); });
        toast(`Duplicated as ${quoted(basename(result.path))}`, { action: { label: 'Undo', run: undoLast } });
    }

    async function trashRows(list) {
        const paths = outermost(list.filter(row => row.kind !== 'x').map(row => row.path));
        if (!paths.length) return;
        const what = paths.length === 1 ? quoted(basename(paths[0])) : `${paths.length} items`;
        if (settings.confirmTrash) {
            const ok = await confirmDialog({
                title: `Move ${what} to the Trash?`,
                detail: `You can put ${paths.length === 1 ? 'it' : 'them'} back with Undo (u) or from the Trash.`,
                confirm: 'Move to Trash',
            });
            if (!ok) return;
        }
        // Move the cursor off what is about to go, to the next row that stays.
        const gone = new Set(paths);
        const after = realRows().slice((rowIndexByPath.get(selected) ?? 0)).find(row => ![...gone].some(path => isWithin(row.path, path)));
        const result = await fsCall('trash', { paths });
        const trashed = result.trashed.filter(item => !item.error);
        const failed = result.trashed.filter(item => item.error);
        marked = new Set();
        for (const { from } of trashed) {
            for (const dir of [...dirs.keys()]) if (isWithin(dir, from)) dirs.delete(dir);
            expanded = new Set([...expanded].filter(dir => !isWithin(dir, from)));
        }
        for (const dir of new Set(trashed.map(item => parentOf(item.from)))) await load(dir);
        if (after) select(after.path, { reveal: false });
        if (failed.length && !trashed.length) throw new Error(failed[0].error);
        const restorable = trashed.filter(item => item.to);
        if (restorable.length) {
            pushUndo(`move to Trash`, async () => {
                const restored = await fsCall('restore', { items: restorable });
                for (const dir of new Set(restored.restored.map(parentOf))) await load(dir);
                if (restored.restored[0]) await revealPath(restored.restored[0], { flash: false });
            });
        }
        const text = failed.length ? `Moved ${trashed.length} of ${paths.length} to the Trash: ${failed[0].error}`
            : `Moved ${paths.length === 1 ? quoted(basename(paths[0])) : `${paths.length} items`} to the Trash`;
        toast(text, restorable.length ? { action: { label: 'Undo', run: undoLast } } : {});
    }

    /** Moves dragged items into `dir`, with Undo. */
    async function moveInto(paths, dir) {
        const list = outermost(paths).filter(path => parentOf(path) !== dir);
        if (!list.length) return;
        for (const path of list) if (isWithin(dir, path)) throw new Error(`${quoted(basename(path))} can't be moved into itself.`);
        const pairs = list.map(path => ({ from: path, to: join(dir, basename(path)) }));
        await fsCall('move', { pairs });
        for (const { from, to } of pairs) remapPaths(from, to);
        expanded.add(dir);
        for (const folder of new Set([dir, ...pairs.map(pair => parentOf(pair.from))])) if (dirs.has(folder) || folder === dir) await load(folder);
        await revealPath(pairs[0].to, { flash: false });
        if (pairs.length > 1) { marked = new Set(pairs.map(pair => pair.to)); syncSelection(); }
        pushUndo(`move of ${pairs.length === 1 ? quoted(basename(pairs[0].from)) : `${pairs.length} items`}`, async () => {
            await fsCall('move', { pairs: pairs.map(pair => ({ from: pair.to, to: pair.from })) });
            for (const { from, to } of pairs) remapPaths(to, from);
            for (const folder of new Set([dir, ...pairs.map(pair => parentOf(pair.from))])) if (dirs.has(folder)) await load(folder);
            await revealPath(pairs[0].from, { flash: false });
        });
        toast(`Moved ${pairs.length === 1 ? quoted(basename(pairs[0].from)) : `${pairs.length} items`} to ${quoted(basename(dir))}`, { action: { label: 'Undo', run: undoLast } });
    }

    // --- Confirm dialog -------------------------------------------------------------------
    function confirmDialog({ title, detail, confirm }) {
        hideMenu();
        hidePeek();
        return new Promise(resolve => {
            dialogState = { resolve, returnFocus: document.activeElement };
            $('dialog-title').textContent = title;
            $('dialog-detail').textContent = detail;
            $('dialog-confirm').textContent = confirm;
            $('dialog-scrim').hidden = false;
            $('dialog-confirm').focus();
        });
    }

    function closeDialog(result) {
        if (!dialogState) return;
        const { resolve, returnFocus } = dialogState;
        dialogState = null;
        $('dialog-scrim').hidden = true;
        (returnFocus instanceof HTMLElement ? returnFocus : tree).focus({ preventScroll: true });
        resolve(result);
    }

    $('dialog-confirm').addEventListener('click', () => closeDialog(true));
    $('dialog-cancel').addEventListener('click', () => closeDialog(false));
    $('dialog-scrim').addEventListener('pointerdown', event => { if (event.target === $('dialog-scrim')) closeDialog(false); });
    $('dialog-scrim').addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); closeDialog(false); }
        else if (event.key === 'Tab') {
            // Keep focus on the two buttons.
            event.preventDefault();
            (document.activeElement === $('dialog-confirm') ? $('dialog-cancel') : $('dialog-confirm')).focus();
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            (document.activeElement === $('dialog-confirm') ? $('dialog-cancel') : $('dialog-confirm')).focus();
        }
    });

    // --- Hover preview --------------------------------------------------------------------
    let peekTimer = null;
    let peekPath = null;
    let peekSeq = 0;
    const peekCache = new Map(); // `${path}\0${mtime}` -> details

    function schedulePeek(row, element) {
        if (!settings.hoverPreview || drag || menuState || editing || dialogState || !row || row.note || row.edit) { cancelPeek(); return; }
        if (peekPath === row.path) return;
        cancelPeek();
        peekPath = row.path;
        peekTimer = setTimeout(() => run(() => showPeek(row, element)), PEEK_DELAY_MS);
    }

    function cancelPeek() {
        clearTimeout(peekTimer);
        peekTimer = null;
        peekPath = null;
    }

    function hidePeek() {
        cancelPeek();
        peekSeq++;
        $('peek').hidden = true;
    }

    async function showPeek(row, element) {
        const seq = ++peekSeq;
        const key = `${row.path}\0${row.mtime}`;
        let details = peekCache.get(key);
        if (!details) {
            details = row.kind === 'x' ? { exists: false } : await fsCall('preview', { path: row.path, showHidden: settings.showHidden });
            peekCache.set(key, details);
            while (peekCache.size > 64) peekCache.delete(peekCache.keys().next().value);
        }
        const index = rowIndexByPath.get(row.path);
        element = index === undefined ? null : document.getElementById(`row-${index}`);
        if (seq !== peekSeq || !element) return;
        const box = $('peek');
        const category = categoryFor(row.name, row.isDir);
        const facts = [];
        if (row.kind === 'x') facts.push('Deleted; still in git');
        else if (details.kind === 'folder') facts.push(itemCount(details.count) || 'Folder');
        else if (details.size !== null && details.size !== undefined) facts.push(humanSize(details.size));
        if (details.mtimeMs) facts.push(`Modified ${relativeTime(details.mtimeMs)}`);
        const code = settings.gitStatus ? row.git : null;
        let body = '';
        if (details.lines?.length) {
            const lines = details.lines.map(line => escapeHTML(printable(line.replace(/\t/g, '    '))) || ' ').join('\n');
            body = `<pre class="peek-text${details.more ? ' more' : ''}">${lines}</pre>`;
        } else if (details.binary) {
            body = '<p class="peek-note">Binary file</p>';
        } else if (details.error) {
            body = `<p class="peek-note">${escapeHTML(details.error)}</p>`;
        }
        box.innerHTML = `<div class="peek-head"><span class="icon cat-${category}">${icon(row.isDir ? 'folder' : category)}</span><span class="peek-name cat-${category}"></span></div>` +
            `<p class="peek-facts">${escapeHTML(facts.join('  ·  '))}${code ? `<span class="peek-git git-${gitClass(code)}">${escapeHTML(row.isDir && code !== '?' && code !== '!' ? folderGitTitle(code) : GIT_LABELS[code])}</span>` : ''}</p>` +
            `<p class="peek-path"></p>${body}`;
        box.querySelector('.peek-name').textContent = printable(row.name);
        // Where it is, from the tree's top folder; the top folder's own items need no line.
        const where = parentOf(row.path);
        const pathLine = box.querySelector('.peek-path');
        pathLine.innerHTML = `<bdi>${escapeHTML(root && isWithin(where, root) ? (where === root ? '' : printable(relativeTo(where, root))) : displayPath(where))}</bdi>`;
        pathLine.hidden = where === root;
        box.hidden = false;
        const rect = element.getBoundingClientRect();
        const { height } = box.getBoundingClientRect();
        const below = rect.bottom + 4;
        box.style.top = `${below + height <= innerHeight - 30 ? below : Math.max(6, rect.top - height - 4)}px`;
    }

    // --- Context menu ---------------------------------------------------------------------
    /**
     * Items: { label, detail, key, glyph, check, disabled, danger, run }, '-' for a separator,
     * or { header } for a section title.
     */
    function menuFor(row) {
        const items = [];
        const target = terminalTarget();
        const claude = panesByID.get(target ?? '')?.agentKind === 'claude';
        const inRepo = Boolean(repoTopFor(row?.path ?? root));
        if (!row) {
            items.push(
                { label: 'New File…', key: 'a', glyph: 'filePlus', run: () => startCreate('file', root) },
                { label: 'New Folder…', key: '⇧A', glyph: 'folderPlus', run: () => startCreate('folder', root) },
                '-',
                { label: 'Copy Path', key: 'c', run: () => copyPaths([root]) },
                { label: revealLabel(), key: 'r', run: () => reveal(root) },
                { label: 'Open Terminal Here', glyph: 'terminal', run: () => openTerminalAt(root) },
                ...(inRepo ? [{ label: 'Open Changes', glyph: 'diff', run: () => openChanges(root) }] : []),
                '-',
                { label: prefs.bookmarks.includes(root) ? 'Remove Bookmark' : 'Bookmark This Folder', key: 'b', glyph: 'bookmark', run: () => toggleBookmark(root) },
                { label: prefs.pinnedRoot ? 'Unpin Folder' : 'Pin Folder', key: 'p', glyph: 'pin', run: () => setPinned(prefs.pinnedRoot ? null : root) },
                { label: 'Refresh', glyph: 'refresh', run: () => reloadAll() },
                { label: 'Collapse All', key: '⇧W', glyph: 'collapse', run: () => collapseAll() },
            );
            return items;
        }
        const list = targets();
        if (list.length > 1) {
            const paths = list.map(item => item.path);
            items.push(
                { header: `${list.length} items selected` },
                { label: claude ? 'Mention in Claude' : 'Insert Paths in Terminal', key: 'i', disabled: !target, run: () => insertPaths(paths) },
                { label: 'Copy Paths', key: 'c', glyph: 'copy', run: () => copyPaths(paths) },
                { label: 'Copy Relative Paths', key: '⇧C', run: () => copyPaths(paths, true) },
                '-',
                { label: 'Move to Trash', key: 'd', glyph: 'trash', danger: true, disabled: list.every(item => item.kind === 'x'), run: () => trashRows(list) },
            );
            return items;
        }
        const changed = settings.gitStatus && CHANGE_CODES.has(row.git);
        const insert = { label: claude ? 'Mention in Claude' : 'Insert Path in Terminal', key: 'i', disabled: !target, run: () => insertPaths([row.path]) };
        if (row.kind === 'x') {
            items.push(
                { header: 'Deleted, still in git' },
                { label: 'Open Changes', key: 'g', glyph: 'diff', run: () => openChanges(row.path) },
                '-',
                { label: 'Copy Path', key: 'c', run: () => copyPaths([row.path]) },
                { label: 'Copy Relative Path', key: '⇧C', run: () => copyPaths([row.path], true) },
            );
            return items;
        }
        if (row.isDir) {
            items.push(
                { label: row.open ? 'Collapse' : 'Expand', key: '⏎', run: () => toggle(row) },
                { label: 'Pin as Root', glyph: 'pin', run: () => setPinned(row.path) },
                { label: prefs.bookmarks.includes(row.path) ? 'Remove Bookmark' : 'Add to Bookmarks', key: 'b', glyph: 'bookmark', run: () => toggleBookmark(row.path) },
                { label: 'Open Terminal Here', glyph: 'terminal', run: () => openTerminalAt(row.path) },
            );
        } else {
            items.push(
                { label: 'Open', key: '⏎', run: () => open(row) },
                { label: 'Open in Editor', key: 'e', glyph: 'pencil', run: () => open(row, { raw: true }) },
                { label: 'Open with Default App', run: () => fsCall('openExternal', { path: row.path }).then(() => toast(`Opened ${printable(row.name)}`)) },
            );
        }
        if (changed && inRepo) items.push({ label: 'Open Changes', key: 'g', glyph: 'diff', run: () => openChanges(row.path) });
        const newDir = row.isDir ? row.path : parentOf(row.path);
        items.push('-',
            { label: 'New File…', key: 'a', glyph: 'filePlus', run: () => startCreate('file', newDir) },
            { label: 'New Folder…', key: '⇧A', glyph: 'folderPlus', run: () => startCreate('folder', newDir) },
            { label: 'Rename…', key: 'F2', run: () => startRename(row) },
            { label: 'Duplicate', key: '⇧D', glyph: 'copy', run: () => duplicate(row) },
            { label: 'Move to Trash', key: 'd', glyph: 'trash', danger: true, run: () => trashRows([row]) },
            '-', insert,
            { label: 'Copy Path', key: 'c', run: () => copyPaths([row.path]) },
            { label: 'Copy Relative Path', key: '⇧C', run: () => copyPaths([row.path], true) },
            '-',
            { label: revealLabel(), key: 'r', run: () => reveal(row.path) });
        return items;
    }

    function moreMenu() {
        const last = history[history.length - 1];
        return [
            { label: 'New File…', key: 'a', glyph: 'filePlus', disabled: !root, run: () => startCreate('file') },
            { label: 'New Folder…', key: '⇧A', glyph: 'folderPlus', disabled: !root, run: () => startCreate('folder') },
            { label: 'Search in Files…', key: '⇧F', glyph: 'textSearch', disabled: !root, run: () => openSearch('content') },
            '-',
            { header: 'Sort by' },
            ...SORTS.map(sort => ({ label: SORT_LABELS[sort], check: settings.sort === sort, key: settings.sort === sort ? 's' : '', run: () => setSetting('sort', sort) })),
            { label: 'Folders First', check: settings.foldersFirst, run: () => setSetting('foldersFirst', !settings.foldersFirst) },
            '-',
            { label: 'Hidden Files', key: '.', check: settings.showHidden, run: toggleHidden },
            { label: 'Git-Ignored Files', key: '⇧I', check: !settings.hideIgnored, run: toggleIgnored },
            { label: 'Git Status', check: settings.gitStatus, run: () => setSetting('gitStatus', !settings.gitStatus) },
            { label: 'Preview on Hover', check: settings.hoverPreview, run: () => setSetting('hoverPreview', !settings.hoverPreview) },
            '-',
            { label: last ? `Undo ${last.label}` : 'Undo', key: 'u', glyph: 'undo', disabled: !last, run: undoLast },
            { label: 'Refresh', glyph: 'refresh', disabled: !root, run: () => reloadAll() },
            { label: 'Collapse All', key: '⇧W', glyph: 'collapse', disabled: !root, run: () => collapseAll() },
            { label: 'Keyboard Shortcuts', key: '?', run: () => toggleHelp(true) },
        ];
    }

    function bookmarksMenu() {
        const items = [];
        if (prefs.bookmarks.length) {
            items.push({ header: 'Bookmarks' });
            for (const path of prefs.bookmarks) {
                items.push({ label: printable(basename(path)), detail: displayPath(parentOf(path)), glyph: 'folder', check: path === root, run: () => setPinned(path) });
            }
            items.push('-');
        } else {
            items.push({ header: 'No bookmarks yet' });
        }
        if (root) items.push({ label: prefs.bookmarks.includes(root) ? 'Remove This Folder' : 'Bookmark This Folder', key: 'b', glyph: 'bookmark', run: () => toggleBookmark(root) });
        if (prefs.bookmarks.length) items.push({ label: 'Clear All Bookmarks', run: () => { prefs = { ...prefs, bookmarks: [] }; savePrefs(); updateHeader(); } });
        return items;
    }

    function showMenu(x, y, items, { from = null } = {}) {
        hidePeek();
        const menu = $('menu');
        menu.replaceChildren();
        const buttons = [];
        const hasChecks = items.some(item => item && item.check !== undefined);
        for (const item of items) {
            if (item === '-') { const sep = document.createElement('div'); sep.className = 'menu-sep'; sep.setAttribute('role', 'separator'); menu.append(sep); continue; }
            if (item.header) { const header = document.createElement('div'); header.className = `menu-header${hasChecks ? ' indented' : ''}`; header.textContent = item.header; header.setAttribute('role', 'presentation'); menu.append(header); continue; }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `menu-item${item.danger ? ' danger' : ''}`;
            button.setAttribute('role', item.check === undefined ? 'menuitem' : 'menuitemcheckbox');
            if (item.check !== undefined) button.setAttribute('aria-checked', String(item.check));
            button.disabled = Boolean(item.disabled);
            button.innerHTML = (hasChecks ? `<span class="menu-check">${item.check ? icon('check') : ''}</span>` : '') +
                `<span class="menu-label"></span>${item.detail ? '<span class="menu-detail"></span>' : ''}${item.key ? `<kbd>${escapeHTML(item.key)}</kbd>` : ''}`;
            button.querySelector('.menu-label').textContent = item.label;
            if (item.detail) button.querySelector('.menu-detail').innerHTML = `<bdi>${escapeHTML(item.detail)}</bdi>`;
            button.addEventListener('click', () => { hideMenu(); run(item.run); });
            button.addEventListener('pointerenter', () => setMenuActive(buttons.indexOf(button)));
            buttons.push(button);
            menu.append(button);
        }
        menu.hidden = false;
        const { width, height } = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
        menu.style.top = `${y + height > innerHeight - 6 ? Math.max(6, y - height) : y}px`;
        menuState = { buttons, active: -1, from };
        from?.setAttribute('aria-expanded', 'true');
    }

    function setMenuActive(index) {
        if (!menuState) return;
        menuState.active = index;
        menuState.buttons.forEach((button, at) => button.classList.toggle('active', at === index));
        menuState.buttons[index]?.focus({ preventScroll: true });
    }

    function hideMenu() {
        if (!menuState) return;
        $('menu').hidden = true;
        menuState.from?.setAttribute('aria-expanded', 'false');
        menuState = null;
    }

    function menuFromButton(button, items) {
        if (menuState?.from === button) { hideMenu(); return; }
        const box = button.getBoundingClientRect();
        showMenu(box.right, box.bottom + 4, items, { from: button });
        // Right-align to the button.
        const menu = $('menu');
        menu.style.left = `${Math.max(6, box.right - menu.getBoundingClientRect().width)}px`;
    }

    $('menu').addEventListener('keydown', event => {
        if (!menuState) return;
        event.stopPropagation();
        const enabled = menuState.buttons.map((button, index) => button.disabled ? -1 : index).filter(index => index >= 0);
        const position = enabled.indexOf(menuState.active);
        if (event.key === 'ArrowDown') { event.preventDefault(); setMenuActive(enabled[(position + 1) % enabled.length]); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setMenuActive(enabled[(position - 1 + enabled.length) % enabled.length]); }
        else if (event.key === 'Home') { event.preventDefault(); setMenuActive(enabled[0]); }
        else if (event.key === 'End') { event.preventDefault(); setMenuActive(enabled[enabled.length - 1]); }
        else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); const from = menuState.from; hideMenu(); (from ?? tree).focus(); }
    });
    window.addEventListener('pointerdown', event => {
        if (menuState && !$('menu').contains(event.target) && !menuState.from?.contains(event.target)) hideMenu();
    }, true);
    window.addEventListener('blur', () => { hideMenu(); hidePeek(); pointerDown = false; });

    // --- Help -----------------------------------------------------------------------------
    const HELP = () => [
        ['Move', [
            ['↑ ↓  j k', 'Move'], ['⇧↑ ⇧↓', 'Extend selection'], ['← →  h l', 'Collapse / expand'],
            [isMac() ? '⌘A' : 'Ctrl A', 'Select all'], ['Esc', 'Clear selection'],
        ]],
        ['Open', [
            ['⏎', 'Open (folders toggle)'], ['e', 'Open in editor'], ['Space', 'Preview'], ['g', 'Open changes (git)'],
            ['i', 'Insert path in terminal'], ['c  ⇧C', 'Copy path / relative path'], ['r', revealLabel()],
        ]],
        ['Change', [
            ['a  ⇧A', 'New file / folder'], ['F2  m', 'Rename'], ['⇧D', 'Duplicate'], [isMac() ? 'd  ⌘⌫' : 'd  Delete', 'Move to Trash'],
            [isMac() ? 'u  ⌘Z' : 'u  Ctrl Z', 'Undo'], ['Drag', 'Move into a folder'],
        ]],
        ['View', [
            ['/  ⇧F', 'Search names / text'], ['s', 'Sort order'], ['.', 'Hidden files'], ['⇧I', 'Git-ignored files'],
            ['p', 'Pin folder'], ['b  ⇧B', 'Bookmark / bookmarks'], ['⇧W', 'Collapse all'], ['?', 'This help'],
        ]],
    ];
    function toggleHelp(force) {
        const help = $('help');
        const show = force ?? help.hidden;
        if (show) {
            help.innerHTML = `<h2>Keyboard</h2>${HELP().map(([group, keys]) => `<h3>${escapeHTML(group)}</h3><dl>${keys.map(([combo, label]) => `<dt><kbd>${escapeHTML(combo)}</kbd></dt><dd>${escapeHTML(label)}</dd>`).join('')}</dl>`).join('')}`;
            hidePeek();
        }
        help.hidden = !show;
    }

    // --- Search ---------------------------------------------------------------------------
    function setSearchMode(mode) {
        searchMode = mode;
        const content = mode === 'content';
        $('search-mode').innerHTML = icon(content ? 'textSearch' : 'fileSearch');
        $('search-mode').setAttribute('aria-label', content ? 'Searching text in files. Switch to names' : 'Searching file names. Switch to text');
        $('search-mode').title = content ? 'Searching text in files: switch to names  (Tab)' : 'Searching file names: switch to text  (Tab)';
        $('search-mode').setAttribute('aria-pressed', String(content));
        $('search-regex').hidden = !content;
        $('search-regex').setAttribute('aria-pressed', String(prefs.regex));
        searchInput.placeholder = content ? 'Search text in files' : 'Search files and folders';
        searchInput.setAttribute('aria-label', searchInput.placeholder);
    }

    function openSearch(mode = 'files') {
        if (!root) return;
        hideMenu();
        hidePeek();
        toggleHelp(false);
        cancelEdit();
        const reopen = searchOpen && searchMode === mode;
        searchOpen = true;
        setSearchMode(mode);
        $('search-bar').hidden = false;
        tree.hidden = true;
        resultsBox.hidden = false;
        if (!reopen) searchInput.value = '';
        searchInput.focus();
        searchInput.select();
        updateState();
        runSearch(searchInput.value, 0);
    }

    function closeSearch() {
        if (!searchOpen) return;
        searchOpen = false;
        searchSeq++;
        if (searchMode === 'content') void fsCall('grep', { token: watchToken, root, query: '' }).catch(() => {});
        clearTimeout(searchTimer);
        $('search-bar').hidden = true;
        $('search-note').hidden = true;
        resultsBox.hidden = true;
        resultsBox.replaceChildren();
        tree.hidden = false;
        updateState();
        render();
        tree.focus();
    }

    function runSearch(query, delay = searchMode === 'content' ? 180 : 70) {
        clearTimeout(searchTimer);
        const seq = ++searchSeq;
        const mode = searchMode;
        if (mode === 'content' && query.trim() && (!searchResults.length || resultsBox.querySelector('.result.empty'))) renderEmptyResults('Searching…');
        searchTimer = setTimeout(async () => {
            try {
                const common = { root, showHidden: settings.showHidden, exclude: settings.exclude };
                const result = mode === 'content'
                    ? (query.trim() ? await fsCall('grep', { ...common, token: watchToken, query, regex: prefs.regex }) : { results: [], truncated: false, empty: true })
                    : await fsCall('search', { ...common, query, hideIgnored: settings.hideIgnored });
                if (seq !== searchSeq || !searchOpen || result.replaced) return;
                searchRoot = root;
                resultIndex = 0;
                const note = $('search-note');
                if (mode === 'content') {
                    searchResults = contentItems(result.results);
                    resultIndex = Math.max(0, searchResults.findIndex(item => item.type === 'match'));
                    note.textContent = result.truncated ? `Showing the first ${result.results.length} matches`
                        : result.tool === 'grep' ? 'Install ripgrep for faster search that skips git-ignored files' : '';
                    note.hidden = !note.textContent;
                    renderContentResults(query, result.empty);
                } else {
                    searchResults = result.results.map(([relative, isDir, positions]) => ({ relative, isDir, positions }));
                    note.textContent = result.truncated ? `Searched the first ${result.indexed.toLocaleString()} entries` : '';
                    note.hidden = !result.truncated;
                    renderResults();
                }
            } catch (cause) {
                if (seq !== searchSeq) return;
                if (mode === 'content') { searchResults = []; renderEmptyResults(message(cause), true); }
                else fail(cause);
            }
        }, delay);
    }

    function highlight(text, offset, positions) {
        let html = '';
        let inMark = false;
        for (let index = 0; index < text.length; index++) {
            const hit = positions.has(index + offset);
            if (hit !== inMark) { html += hit ? '<mark>' : '</mark>'; inMark = hit; }
            html += escapeHTML(printable(text[index]));
        }
        return inMark ? `${html}</mark>` : html;
    }

    function renderEmptyResults(text, error = false) {
        resultsBox.replaceChildren();
        const empty = document.createElement('div');
        empty.className = `result empty${error ? ' error' : ''}`;
        empty.textContent = text;
        resultsBox.append(empty);
        searchInput.removeAttribute('aria-activedescendant');
    }

    function renderResults() {
        resultsBox.replaceChildren();
        if (!searchResults.length) { renderEmptyResults('No matches'); return; }
        searchResults.forEach((result, index) => {
            const slash = result.relative.lastIndexOf('/');
            const name = result.relative.slice(slash + 1);
            const dir = slash === -1 ? '' : result.relative.slice(0, slash);
            const positions = new Set(result.positions);
            const category = categoryFor(name, result.isDir);
            const element = document.createElement('div');
            element.className = 'result';
            element.id = `result-${index}`;
            element.setAttribute('role', 'option');
            element.setAttribute('aria-selected', String(index === resultIndex));
            element.title = printable(result.relative);
            element.innerHTML = `<span class="icon cat-${category}">${icon(result.isDir ? 'folder' : category)}</span>` +
                `<span class="result-text"><span class="result-name cat-${category}">${highlight(name, slash + 1, positions)}</span>` +
                (dir ? `<span class="result-dir">${highlight(dir, 0, positions)}</span>` : '') + '</span>';
            element.addEventListener('click', () => { resultIndex = index; run(chooseResult); });
            resultsBox.append(element);
        });
        syncResultSelection();
    }

    /** Content matches grouped under one header per file: `{ type: 'file'|'match', path, ... }`. */
    function contentItems(matches) {
        const byFile = new Map();
        for (const match of matches) {
            if (!byFile.has(match.path)) byFile.set(match.path, []);
            byFile.get(match.path).push(match);
        }
        const items = [];
        // ripgrep searches files in parallel, so its order changes from run to run.
        const paths = [...byFile.keys()].sort((a, b) => pathCollator.compare(a, b));
        for (const path of paths) {
            const list = byFile.get(path).sort((a, b) => a.line - b.line);
            items.push({ type: 'file', path, count: list.length });
            for (const match of list) items.push({ type: 'match', ...match });
        }
        return items;
    }

    function markRanges(text, ranges) {
        let html = '';
        let at = 0;
        for (const [start, end] of ranges) {
            if (start < at) continue;
            html += escapeHTML(printable(text.slice(at, start))) + `<mark>${escapeHTML(printable(text.slice(start, end)))}</mark>`;
            at = end;
        }
        return html + escapeHTML(printable(text.slice(at)));
    }

    function renderContentResults(query, empty) {
        resultsBox.replaceChildren();
        if (empty) { renderEmptyResults('Type to search the text of every file here'); return; }
        if (!searchResults.length) { renderEmptyResults(`No files contain ${quoted(query)}`); return; }
        const width = String(Math.max(...searchResults.filter(item => item.type === 'match').map(item => item.line))).length;
        searchResults.forEach((item, index) => {
            const element = document.createElement('div');
            element.id = `result-${index}`;
            element.setAttribute('role', 'option');
            element.setAttribute('aria-selected', String(index === resultIndex));
            if (item.type === 'file') {
                const slash = item.path.lastIndexOf('/');
                const name = item.path.slice(slash + 1);
                const category = categoryFor(name, false);
                element.className = 'result file-head';
                element.title = printable(item.path);
                element.innerHTML = `<span class="icon cat-${category}">${icon(category)}</span><span class="result-text"><span class="result-name cat-${category}"></span>` +
                    `${slash === -1 ? '' : '<span class="result-dir"></span>'}</span><span class="result-count">${item.count}</span>`;
                element.querySelector('.result-name').textContent = printable(name);
                if (slash !== -1) element.querySelector('.result-dir').textContent = printable(item.path.slice(0, slash));
            } else {
                element.className = 'result match';
                element.style.setProperty('--line-width', `${width}ch`);
                element.title = `${printable(item.path)}:${item.line}`;
                element.innerHTML = `<span class="line-number">${item.line}</span><span class="snippet">${markRanges(item.text, item.ranges)}</span>`;
            }
            element.addEventListener('click', () => { resultIndex = index; run(chooseResult); });
            resultsBox.append(element);
        });
        syncResultSelection();
    }

    function syncResultSelection() {
        for (const element of resultsBox.querySelectorAll('.result[role="option"]')) {
            element.setAttribute('aria-selected', String(element.id === `result-${resultIndex}`));
        }
        const active = document.getElementById(`result-${resultIndex}`);
        if (active) {
            searchInput.setAttribute('aria-activedescendant', active.id);
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    async function chooseResult() {
        const result = searchResults[resultIndex];
        if (!result) return;
        // The followed pane may have moved since these results arrived.
        if (searchRoot !== root) { runSearch(searchInput.value, 0); toast('The folder changed; results updated.'); return; }
        const relative = result.relative ?? result.path;
        const path = join(root, relative);
        closeSearch();
        await revealPath(path);
        const row = selectedRow();
        if (!row || row.isDir) return;
        if (searchMode === 'content') await open(row, { line: result.type === 'match' ? result.line : null });
        else await open(row);
    }

    searchInput.addEventListener('input', () => runSearch(searchInput.value));
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
            event.preventDefault();
            resultIndex = Math.min(searchResults.length - 1, resultIndex + 1);
            syncResultSelection();
        } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
            event.preventDefault();
            resultIndex = Math.max(0, resultIndex - 1);
            syncResultSelection();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            run(chooseResult);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
        } else if (event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            setSearchMode(searchMode === 'files' ? 'content' : 'files');
            runSearch(searchInput.value, 0);
        }
    });
    $('search-mode').addEventListener('click', () => {
        setSearchMode(searchMode === 'files' ? 'content' : 'files');
        searchInput.focus();
        runSearch(searchInput.value, 0);
    });
    $('search-regex').addEventListener('click', () => {
        prefs = { ...prefs, regex: !prefs.regex };
        savePrefs();
        setSearchMode(searchMode);
        searchInput.focus();
        runSearch(searchInput.value, 0);
    });

    // --- Tree input -----------------------------------------------------------------------
    const rowFromEvent = event => {
        const element = event.target.closest?.('.row');
        return element ? rows[Number(element.dataset.index)] ?? null : null;
    };
    const fromEditBox = event => editBox.contains(event.target);

    tree.addEventListener('pointerdown', event => { if (!fromEditBox(event)) pointerDown = true; hidePeek(); });
    // A drag ends with pointercancel and dragend, never pointerup.
    const releasePointer = () => {
        if (!pointerDown) return;
        pointerDown = false;
        if (renderAfterPointer) { renderAfterPointer = false; setTimeout(() => queueRender(true), 0); }
    };
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
    tree.addEventListener('scroll', () => { queueRender(true); hidePeek(); }, { passive: true });
    tree.addEventListener('pointermove', event => {
        if (event.pointerType !== 'mouse' || pointerDown) return;
        const element = event.target.closest?.('.row');
        schedulePeek(element ? rows[Number(element.dataset.index)] : null, element);
    });
    tree.addEventListener('pointerleave', hidePeek);

    tree.addEventListener('click', event => {
        hideMenu();
        if (fromEditBox(event)) return;
        const row = rowFromEvent(event);
        if (!row || row.note || row.edit) {
            if (!row && !event.metaKey && !event.ctrlKey && !event.shiftKey) clearMarks();
            return;
        }
        const additive = isMac() ? event.metaKey : event.ctrlKey;
        if (additive) { toggleMark(row.path); return; }
        if (event.shiftKey) { markRange(row.path); return; }
        select(row.path, { reveal: false });
        if (row.isDir && row.kind !== 'x') { if (event.detail <= 1) toggle(row); }
        else if (event.detail === 2) run(() => open(row));
    });

    tree.addEventListener('contextmenu', event => {
        if (fromEditBox(event)) return;
        event.preventDefault();
        if (!root) return;
        const row = rowFromEvent(event);
        if (row?.note || row?.edit) return;
        // Right-clicking inside a multi-selection acts on all of it; elsewhere, on that row alone.
        if (row && !(marked.size && marked.has(row.path))) select(row.path, { reveal: false });
        if (row && marked.has(row.path)) { selected = row.path; syncSelection(); }
        tree.focus();
        showMenu(event.clientX, event.clientY, menuFor(row));
    });

    // --- Drag and drop --------------------------------------------------------------------
    const DRAG_TYPE = 'application/x-andymarcus-filetree';

    tree.addEventListener('dragstart', event => {
        const row = rowFromEvent(event);
        if (!row || row.note || row.edit || row.kind === 'x') { event.preventDefault(); return; }
        hidePeek();
        const list = marked.has(row.path) ? targets().filter(item => item.kind !== 'x') : [row];
        const paths = list.map(item => item.path);
        if (paths.some(path => CONTROL_CHARACTERS.test(path))) { event.preventDefault(); toast('A name contains control characters; copy the path instead.'); return; }
        drag = { paths, target: null, expandTimer: null };
        event.dataTransfer.effectAllowed = 'copyMove';
        // A terminal pane gets the quoted paths; this tree gets the move.
        event.dataTransfer.setData('text/plain', paths.map(shellQuote).join(' '));
        event.dataTransfer.setData('text/uri-list', paths.map(fileURL).join('\r\n'));
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
        if (paths.length > 1) {
            const ghost = document.createElement('div');
            ghost.className = 'drag-ghost';
            ghost.textContent = `${paths.length} items`;
            document.body.append(ghost);
            event.dataTransfer.setDragImage(ghost, 12, 12);
            setTimeout(() => ghost.remove(), 0);
        }
    });

    /** The folder a drop at this event would move into, or null if it isn't a valid drop. */
    function dropTargetFor(event) {
        if (!drag || !root) return null;
        const row = rowFromEvent(event);
        if (row?.note || row?.edit) return null;
        const dir = !row ? root : row.isDir && row.kind !== 'x' ? row.path : parentOf(row.path);
        if (!isWithin(dir, root)) return null;
        const valid = drag.paths.some(path => parentOf(path) !== dir) && !drag.paths.some(path => isWithin(dir, path));
        return valid ? dir : null;
    }

    function setDropTarget(dir) {
        if (drag.target === dir) return;
        clearTimeout(drag.expandTimer);
        drag.target = dir;
        tree.classList.toggle('drop-root', dir === root);
        for (const element of spacer.querySelectorAll('.row.drop-target')) element.classList.remove('drop-target');
        const index = dir && dir !== root ? rowIndexByPath.get(dir) : undefined;
        if (index !== undefined) document.getElementById(`row-${index}`)?.classList.add('drop-target');
        // Resting on a closed folder opens it, so a drop can go deeper.
        const row = index !== undefined ? rows[index] : null;
        if (row?.isDir && !row.open) drag.expandTimer = setTimeout(() => { if (drag?.target === dir) toggle(row, true); }, DRAG_EXPAND_MS);
    }

    tree.addEventListener('dragover', event => {
        if (!drag || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        const dir = dropTargetFor(event);
        setDropTarget(dir);
        if (!dir) { event.dataTransfer.dropEffect = 'none'; return; }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    });
    tree.addEventListener('dragleave', event => {
        if (drag && !tree.contains(event.relatedTarget)) setDropTarget(null);
    });
    tree.addEventListener('drop', event => {
        if (!drag) return;
        event.preventDefault();
        const dir = drag.target;
        const paths = drag.paths;
        endDrag();
        if (dir) run(() => moveInto(paths, dir));
    });
    function endDrag() {
        if (!drag) return;
        clearTimeout(drag.expandTimer);
        drag = null;
        tree.classList.remove('drop-root');
        for (const element of spacer.querySelectorAll('.row.drop-target')) element.classList.remove('drop-target');
    }
    tree.addEventListener('dragend', () => { endDrag(); releasePointer(); });

    // --- Keyboard -------------------------------------------------------------------------
    tree.addEventListener('keydown', event => {
        if (fromEditBox(event) || !root) return;
        const row = selectedRow();
        const peekOpen = !$('peek').hidden;
        if (event.key !== ' ') hidePeek();
        const handled = () => { event.preventDefault(); event.stopPropagation(); };
        const command = isMac() ? event.metaKey : event.ctrlKey;
        if (command && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === 'z' && !event.shiftKey) { handled(); run(undoLast); }
            else if (key === 'a') { handled(); selectAll(); }
            else if (event.key === 'Backspace' && isMac()) { handled(); run(() => trashRows(targets())); }
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const page = Math.max(1, Math.floor(tree.clientHeight / ROW_HEIGHT) - 1);
        const extend = event.shiftKey;
        switch (event.key) {
            case 'ArrowDown': case 'j': handled(); moveSelection(1, { extend: extend && event.key === 'ArrowDown' }); break;
            case 'ArrowUp': case 'k': handled(); moveSelection(-1, { extend: extend && event.key === 'ArrowUp' }); break;
            case 'PageDown': handled(); moveSelection(page, { extend }); break;
            case 'PageUp': handled(); moveSelection(-page, { extend }); break;
            case 'Home': handled(); moveSelection(-rows.length, { extend }); break;
            case 'End': handled(); moveSelection(rows.length, { extend }); break;
            case 'ArrowRight': case 'l':
                handled();
                if (row?.isDir && !row.open) toggle(row, true);
                else if (row?.isDir) moveSelection(1);
                break;
            case 'ArrowLeft': case 'h': {
                handled();
                if (row?.isDir && row.open) { toggle(row, false); break; }
                if (row && parentOf(row.path) !== root && rowIndexByPath.has(parentOf(row.path))) select(parentOf(row.path));
                break;
            }
            case 'Enter': case 'o': if (row) { handled(); run(() => open(row)); } break;
            case 'e': if (row && !row.isDir) { handled(); run(() => open(row, { raw: true })); } break;
            case ' ': {
                handled();
                if (peekOpen) { hidePeek(); break; }
                const index = row ? rowIndexByPath.get(row.path) : undefined;
                const element = index === undefined ? null : document.getElementById(`row-${index}`);
                if (row && element) run(() => showPeek(row, element));
                break;
            }
            case 'g':
                if (!row) break;
                handled();
                if (settings.gitStatus && CHANGE_CODES.has(row.git)) run(() => openChanges(row.path));
                else toast(row.git === '?' ? 'This is untracked, so git has no changes to show.' : 'No git changes here.');
                break;
            case 'i': if (targets().length) { handled(); run(() => insertPaths(targets().map(item => item.path))); } break;
            case 'c': handled(); run(() => copyPaths(targets().length ? targets().map(item => item.path) : [root])); break;
            case 'C': handled(); run(() => copyPaths(targets().length ? targets().map(item => item.path) : [root], true)); break;
            case 'r': handled(); run(() => reveal(row?.path ?? root)); break;
            case 'a': handled(); run(() => startCreate('file')); break;
            case 'A': handled(); run(() => startCreate('folder')); break;
            case 'F2': case 'm': if (row) { handled(); startRename(row); } break;
            case 'D': if (row) { handled(); run(() => duplicate(row)); } break;
            case 'd': case 'Delete': if (targets().length) { handled(); run(() => trashRows(targets())); } break;
            case 'u': handled(); run(undoLast); break;
            case 's': handled(); cycleSort(); break;
            case '.': handled(); toggleHidden(); break;
            case 'I': handled(); toggleIgnored(); break;
            case '/': handled(); openSearch('files'); break;
            case 'F': handled(); openSearch('content'); break;
            case 'p': handled(); setPinned(prefs.pinnedRoot ? null : root); break;
            case 'b': handled(); toggleBookmark(row?.isDir && row.kind !== 'x' ? row.path : root); break;
            case 'B': handled(); menuFromButton($('btn-bookmarks'), bookmarksMenu()); setMenuActive(0); break;
            case 'W': handled(); collapseAll(); break;
            case '?': handled(); toggleHelp(); break;
            case 'Escape':
                if (!$('help').hidden || menuState || peekOpen) { handled(); toggleHelp(false); hideMenu(); hidePeek(); }
                else if (marked.size) { handled(); clearMarks(); }
                break;
            case 'ContextMenu': {
                handled();
                const index = row ? rowIndexByPath.get(row.path) : undefined;
                const element = index === undefined ? null : document.getElementById(`row-${index}`);
                const box = element?.getBoundingClientRect() ?? tree.getBoundingClientRect();
                showMenu(box.left + 24, box.bottom, menuFor(row));
                setMenuActive(0);
                break;
            }
            default: break;
        }
    });

    // With nothing focused (after the pointer left a menu, say), keys still drive the tree.
    document.addEventListener('keydown', event => {
        if (document.activeElement !== document.body || event.defaultPrevented || dialogState) return;
        const copy = new KeyboardEvent('keydown', { key: event.key, code: event.code, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, bubbles: true, cancelable: true });
        tree.dispatchEvent(copy);
        // Only keys the tree used are taken; the rest (app shortcuts) pass through.
        if (copy.defaultPrevented) { event.preventDefault(); tree.focus({ preventScroll: true }); }
    });

    tree.addEventListener('focus', () => {
        // Only keyboard focus picks a row; a click selects the row it lands on.
        if (!selected && rows.length && !pointerDown) {
            const first = rows.find(item => item.path && !item.note && !item.edit);
            if (first) select(first.path);
        }
        syncSelection();
    });
    tree.addEventListener('blur', () => syncSelection());

    editInput.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); run(() => commitEdit()); }
        else if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
    });
    editInput.addEventListener('input', () => { $('edit-error').hidden = true; });
    editInput.addEventListener('blur', () => {
        // A click on the error or the dialog keeps the box; anything else commits it.
        setTimeout(() => { if (editing && document.activeElement !== editInput && !dialogState) run(() => commitEdit({ fromBlur: true })); }, 0);
    });

    // --- Header buttons -------------------------------------------------------------------
    $('btn-search').innerHTML = icon('search');
    $('btn-bookmarks').innerHTML = icon('bookmark');
    $('btn-pin').innerHTML = icon('pin');
    $('btn-more').innerHTML = icon('more');
    $('search-close').innerHTML = icon('close');
    $('search-regex').innerHTML = icon('regex');
    document.querySelector('.root-icon').innerHTML = icon('folderOpen');
    for (const button of document.querySelectorAll('[data-tip]')) button.title = button.dataset.tip.replace(/ {2}(\S+)$/, '  ($1)');
    setSearchMode('files');

    $('btn-search').addEventListener('click', () => (searchOpen ? closeSearch() : openSearch('files')));
    $('search-close').addEventListener('click', closeSearch);
    $('btn-bookmarks').addEventListener('click', () => menuFromButton($('btn-bookmarks'), bookmarksMenu()));
    $('btn-more').addEventListener('click', () => menuFromButton($('btn-more'), moreMenu()));
    $('btn-pin').addEventListener('click', () => { if (root) setPinned(prefs.pinnedRoot ? null : root); });
    $('root-path').addEventListener('dblclick', () => { if (root) run(() => copyText(root, 'Copied path')); });
    $('branch').addEventListener('click', () => { if (!$('branch').classList.contains('clean')) run(() => openChanges(null)); });

    // --- Watching -------------------------------------------------------------------------
    function syncWatch(force = false) {
        if (!root || !visible) return;
        const list = [root, ...rows.filter(row => row.open && dirs.get(row.path)?.status === 'ready').map(row => row.path)].slice(0, 400);
        const key = list.join('\n');
        if (!force && key === watchKey) return;
        watchKey = key;
        void fsCall('watch', { token: watchToken, dirs: list }).catch(() => {});
    }

    const reloadQueue = new Set();
    let reloadTimer = null;
    function queueReload(dir) {
        reloadQueue.add(dir);
        if (reloadTimer) return;
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            const queued = [...reloadQueue];
            reloadQueue.clear();
            for (const dir of queued) if (dirs.has(dir) && root && isWithin(dir, root)) void load(dir);
        }, 40);
    }

    function onFilesChanged(changed, files) {
        noteChanged(files);
        for (const dir of changed) {
            if (typeof dir !== 'string') continue;
            if (dirs.has(dir)) queueReload(dir);
            // A folder's own item count lives in its parent's listing.
            const parent = parentOf(dir);
            if (parent !== dir && dirs.has(parent) && expanded.has(parent)) queueReload(parent);
        }
        peekCache.clear();
        if (searchOpen) runSearch(searchInput.value, searchMode === 'content' ? 600 : 250);
    }

    /** Git status changed for the repository at `top`: every listing inside it is out of date. */
    function onGitChanged(top) {
        if (!root || typeof top !== 'string') return;
        for (const dir of dirs.keys()) {
            if (isWithin(dir, top) && (dir === root || expanded.has(dir))) queueReload(dir);
        }
    }

    function onCommand(data) {
        if (!visible || !data || typeof data.action !== 'string') return;
        const actions = {
            focus: () => focusTree(),
            search: () => { focusTree(); openSearch('files'); },
            'search-content': () => { focusTree(); openSearch('content'); },
            reveal: () => revealPane(typeof data.paneID === 'string' ? data.paneID : null),
            'new-file': () => { focusTree(); return startCreate('file'); },
            'new-folder': () => { focusTree(); return startCreate('folder'); },
            'collapse-all': () => collapseAll(),
            refresh: () => reloadAll(),
            'toggle-hidden': () => toggleHidden(),
            'toggle-ignored': () => toggleIgnored(),
            'toggle-pin': () => { if (root) setPinned(prefs.pinnedRoot ? null : root); },
            undo: () => undoLast(),
        };
        const action = actions[data.action];
        if (action) run(action);
    }

    function setVisible(next) {
        if (next === visible) return;
        visible = next;
        if (visible) {
            scheduleSourceRefresh(0);
            reloadAll();
            syncWatch(true);
            pollSoon();
        } else {
            schedulePoll();
            hidePeek();
            watchKey = '';
            void fsCall('release', { token: watchToken }).catch(() => {});
        }
    }

    // --- Boot -----------------------------------------------------------------------------
    let booted = false;
    async function loadPreferences() {
        const stored = await api.storage.get(PREFS_KEY);
        const record = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        prefs = {
            pinnedRoot: typeof record.pinnedRoot === 'string' && record.pinnedRoot.startsWith('/') ? record.pinnedRoot : null,
            bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks.filter(item => typeof item === 'string' && item.startsWith('/')) : [],
            regex: record.regex === true,
        };
        let loaded = {};
        try { loaded = await api.settings.get(); } catch { /* an older Kelpi: the defaults apply */ }
        settings = normalizeSettings(loaded);
        // 1.0 kept "show hidden" in view storage; it is a setting now.
        if (record.showHidden === false && !record.settingsMigrated) setSetting('showHidden', false);
        if ('showHidden' in record) { prefs.settingsMigrated = true; savePrefs(); }
    }

    async function boot() {
        await api.ready;
        applyTone();
        updateHeader();
        updateState();
        try {
            await loadPreferences();
            const details = await fsCall('info');
            home = details.home;
            platform = details.platform;
        } catch (cause) {
            backendError = message(cause);
            updateState();
            return;
        }
        backendError = null;
        updateHeader();
        if (prefs.pinnedRoot) setRoot(prefs.pinnedRoot);
        if (booted) { await refreshSource(); return; }
        booted = true;

        if (typeof api.ui.getNavigation === 'function') {
            try { navigation = await api.ui.getNavigation(); } catch { navigation = null; }
            disposers.push(api.ui.onNavigation(value => { navigation = value; scheduleSourceRefresh(0); }, () => { navigation = null; }));
        }
        disposers.push(api.events.on('state.changed', () => scheduleSourceRefresh()));
        disposers.push(api.events.on('gap', () => {
            scheduleSourceRefresh(0);
            reloadAll();
            void api.settings.get().then(applySettings, () => {});
        }));
        disposers.push(api.events.on(`${PLUGIN}.changed`, event => onFilesChanged(event.data?.dirs ?? [], event.data?.files ?? [])));
        disposers.push(api.events.on(`${PLUGIN}.git`, event => onGitChanged(event.data?.top)));
        disposers.push(api.events.on(`${PLUGIN}.command`, event => onCommand(event.data)));
        disposers.push(api.events.on('settings.changed', event => {
            if (event.pluginID && event.pluginID !== PLUGIN) return;
            const { key, value } = event.data ?? {};
            if (typeof key === 'string' && key in DEFAULT_SETTINGS) applySettings({ ...settings, [key]: value });
        }));
        disposers.push(api.onContext(environment => {
            applyTone();
            setVisible(environment.visible !== false);
            scheduleSourceRefresh();
        }));

        const renew = setInterval(() => syncWatch(true), WATCH_RENEW_MS);
        disposers.push(() => clearTimeout(pollTimer), () => clearInterval(renew), () => clearInterval(recentSweep));
        pollSoon();

        try { await refreshSource(); }
        finally { sourceResolved = true; updateState(); }
    }

    window.addEventListener('pagehide', () => {
        disposed = true;
        for (const dispose of disposers) { try { dispose(); } catch { /* already gone */ } }
        void fsCall('release', { token: watchToken }).catch(() => {});
    }, { once: true });

    boot().catch(cause => { backendError = message(cause); updateState(); });
})();
