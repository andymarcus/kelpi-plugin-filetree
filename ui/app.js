/* File Tree sidebar. Shows the folder of the focused Kelpi pane and follows it as you move
   between panes or `cd` around. Build-free: Kelpi is reached through the injected
   window.kelpi API, and the disk through this plugin's own andymarcus.filetree.fs service. */
(() => {
    const api = window.kelpi;
    const { categoryFor, openRoute, extensionOf, isRunnable, icon } = window.FileCategories;

    const SERVICE = 'andymarcus.filetree.fs';
    const PROVIDER = 'andymarcus.filetree.fs.node';
    const CHANGED_EVENT = 'andymarcus.filetree.changed';
    const PREFS_KEY = 'prefs';
    const ROW_HEIGHT = 22;
    const INDENT = 12;
    const OVERSCAN = 8;
    const NARROW_WIDTH = 230;
    // Polling for `cd` in a terminal starts fast and backs off while the folder stays put.
    const POLL_FAST_MS = 1500;
    const POLL_SLOW_MS = 6000;
    const POLL_BACKOFF = 1.5;
    const WATCH_RENEW_MS = 15000;
    const LOADING_GRACE_MS = 150;
    const ROOT_MEMORY_LIMIT = 24;
    // Panes whose folder is worth following. Web, scratchpad and plugin panes keep the last root.
    const FOLLOWED_TYPES = new Set(['shell', 'markdown', 'csv', 'diff']);

    const $ = id => document.getElementById(id);
    const tree = $('tree');
    const spacer = $('spacer');
    const resultsBox = $('results');
    const searchInput = $('search-input');
    const fsCall = (method, args = {}) => api.services.call(SERVICE, 1, method, args, { provider: PROVIDER });
    const message = cause => cause instanceof Error ? cause.message : String(cause);
    const escapeHTML = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

    // --- State ----------------------------------------------------------------------------
    let prefs = { showHidden: true, pinnedRoot: null };
    let platform = 'darwin';
    let home = '';
    let root = null;
    let source = null;           // { workspaceID, paneID, type, agent, title, fallback, cwd }
    let shellPaneID = null;      // last focused terminal in the active workspace
    let panesByID = new Map();   // snapshot panes of the active workspace
    let navigation = null;
    let remoteActive = false;
    let backendError = null;
    let visible = api.visible !== false;
    let disposed = false;

    const dirs = new Map();      // folder path -> { status, entries, total, error, seq, startedAt }
    let loadSeq = 0;             // shared, so a reply from before a root change can never match
    let expanded = new Set();
    let selected = null;         // selected path
    let rows = [];
    let rowIndexByPath = new Map();
    let pendingScrollTop = null;
    const rootMemory = new Map();

    let searchOpen = false;
    let searchResults = [];
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
    const watchToken = crypto.randomUUID();
    let watchKey = '';
    const disposers = [];

    // --- Paths ----------------------------------------------------------------------------
    const join = (dir, name) => dir === '/' ? `/${name}` : `${dir}/${name}`;
    const parentOf = path => { const index = path.lastIndexOf('/'); return index <= 0 ? '/' : path.slice(0, index); };
    const basename = path => path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    const isWithin = (path, base) => path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
    const relativeTo = (path, base) => path === base ? '.' : isWithin(path, base) ? path.slice(base === '/' ? 1 : base.length + 1) : path;
    const displayPath = path => printable(!path ? '' : home && isWithin(path, home) ? (path === home ? '~' : `~/${relativeTo(path, home)}`) : path);
    // Control characters would reach the terminal's line editor raw (Ctrl-C, Ctrl-U, Enter, escapes).
    const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
    const assertTypable = path => {
        if (CONTROL_CHARACTERS.test(path)) throw new Error('This name contains control characters, so it is not sent to a terminal. Copy the path instead.');
    };
    // Shown names draw control characters as symbols (␍ for \r), so a name cannot hide part of
    // itself. One UTF-16 unit for one, so search highlight positions still line up.
    const printable = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
        const code = char.charCodeAt(0);
        return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\ufffd';
    });
    // A relative path starting with - or = would read as an option or a zsh =command.
    const safeRelative = text => /^[-=]/.test(text) ? `./${text}` : text;
    const shellQuote = text => /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
    const fileURL = path => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
    const revealLabel = () => platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Manager';
    const paneTitle = pane => (pane?.label || pane?.title || '').replace(/^[^\p{L}\p{N}]+\s*/u, '').trim();

    function humanSize(bytes) {
        if (bytes === null || bytes === undefined) return '';
        let size = bytes;
        for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
            if (size < 1024 || unit === 'TB') return unit === 'B' ? `${size} B` : `${size.toFixed(1)} ${unit}`;
            size /= 1024;
        }
        return '';
    }
    const itemCount = count => count === null || count === undefined ? '' : `${count} item${count === 1 ? '' : 's'}`;

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

    new ResizeObserver(() => {
        tree.classList.toggle('narrow', document.body.clientWidth < NARROW_WIDTH);
        resultsBox.classList.toggle('narrow', document.body.clientWidth < NARROW_WIDTH);
        queueRender();
    }).observe(document.body);

    // --- Feedback -------------------------------------------------------------------------
    function toast(text) {
        const box = $('toast');
        box.textContent = text;
        box.hidden = false;
        box.style.animation = 'none';
        void box.offsetWidth;
        box.style.animation = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { box.hidden = true; }, 1800);
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
        $('btn-hidden').innerHTML = icon(prefs.showHidden ? 'eye' : 'eyeOff');
        $('btn-hidden').setAttribute('aria-pressed', String(prefs.showHidden));
        $('btn-hidden').title = prefs.showHidden ? 'Hide hidden files  (.)' : 'Show hidden files  (.)';
        updateStatus();
    }

    function updateStatus() {
        const node = root ? dirs.get(root) : null;
        const parts = [];
        if (prefs.pinnedRoot) parts.push('Pinned');
        else if (remoteActive) parts.push('Remote workspace: showing the last local folder');
        else if (source) parts.push(`Following ${paneTitle(source) || (source.type === 'shell' ? 'terminal' : source.type)}`);
        if (node?.status === 'ready') parts.push(itemCount(node.total));
        $('status').textContent = parts.join('  ·  ');
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
        } else if (node?.status === 'ready' && node.entries.length === 0) {
            showState({ glyph: 'folder', title: 'This folder is empty', detail: prefs.showHidden ? '' : 'Hidden files are not shown.' });
        } else {
            showState();
        }
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
            // Title and status updates arrive constantly; only a new pane or a new Kelpi directory
            // needs a lookup now. A `cd` Kelpi doesn't see is the poll's job.
            const needsLookup = !previous || previous.fallback !== fallback || previous.cwd === null;
            source = {
                workspaceID, paneID: focused.id, type: focused.type, agent: focused.agentKind ?? null,
                title: focused.title, label: focused.label, fallback, cwd: previous?.cwd ?? null,
            };
            if (needsLookup) await resolveSourceCwd();
            else updateHeader();
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

    // --- Adaptive polling -----------------------------------------------------------------
    let pollTimer = null;
    let pollDelay = POLL_FAST_MS;
    const pollWanted = () => visible && !prefs.pinnedRoot && !disposed;

    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = pollWanted() ? setTimeout(pollOnce, pollDelay) : null;
    }

    /** Activity (a new pane, a moved folder, files changing): check quickly again. */
    function pollSoon() {
        pollDelay = POLL_FAST_MS;
        schedulePoll();
    }

    async function pollOnce() {
        pollTimer = null;
        let changed = false;
        if (pollWanted() && source?.type === 'shell') {
            try { changed = await resolveSourceCwd(); } catch { /* next poll retries */ }
        }
        pollDelay = changed ? POLL_FAST_MS : Math.min(POLL_SLOW_MS, Math.round(pollDelay * POLL_BACKOFF));
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
        root = next;
        const memory = rootMemory.get(next);
        expanded = new Set((memory?.expanded ?? []).filter(path => isWithin(path, next)));
        expanded.add(next);
        selected = memory?.selected ?? null;
        pendingScrollTop = memory?.scrollTop ?? 0;
        for (const path of dirs.keys()) if (!isWithin(path, next)) dirs.delete(path);
        updateHeader();
        rebuild();
        for (const dir of expanded) void load(dir);
        if (searchOpen) runSearch(searchInput.value, 0);
    }

    async function load(dir) {
        const current = dirs.get(dir);
        const seq = ++loadSeq;
        dirs.set(dir, {
            entries: current?.status === 'ready' ? current.entries : [],
            total: current?.status === 'ready' ? current.total : 0,
            status: current?.status === 'ready' ? 'ready' : 'loading',
            error: null, seq, startedAt: Date.now(),
        });
        if (!current || current.status !== 'ready') scheduleLoadingRebuild();
        let next;
        try {
            const result = await fsCall('list', { path: dir, showHidden: prefs.showHidden });
            next = result.error
                ? { status: 'error', error: result.error, entries: [], total: 0 }
                : { status: 'ready', error: null, total: result.total, entries: result.entries.map(([name, kind, size, count]) => ({ name, kind, size, count, path: join(dir, name) })) };
        } catch (cause) {
            next = { status: 'error', error: message(cause), entries: [], total: 0 };
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
        const walk = (dir, depth) => {
            const node = dirs.get(dir);
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
                next.push({ ...entry, depth, isDir, open, key: entry.path });
                if (open) walk(entry.path, depth + 1);
            }
            if (node.total > node.entries.length) {
                next.push({ note: true, depth, text: `${node.total - node.entries.length} more items not shown`, key: `${dir}\0more` });
            }
        };
        if (root) walk(root, 0);
        rows = next;
        rowIndexByPath = new Map();
        rows.forEach((row, index) => { if (!row.note) rowIndexByPath.set(row.path, index); });
        if (selected && !rowIndexByPath.has(selected) && !isLoadingAncestor(selected)) selected = null;
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
            element.innerHTML += `<span class="twisty"></span><span class="icon">${row.error ? icon('alert') : ''}</span><span class="name"></span>`;
            element.querySelector('.name').textContent = row.text;
            element.setAttribute('role', 'none');
            return element;
        }
        const category = categoryFor(row.name, row.isDir);
        const iconName = row.isDir ? (row.open ? 'folderOpen' : 'folder') : category;
        element.id = `row-${index}`;
        element.setAttribute('role', 'treeitem');
        element.setAttribute('aria-level', String(row.depth + 1));
        element.setAttribute('aria-selected', String(row.path === selected));
        if (row.isDir) { element.setAttribute('aria-expanded', String(row.open)); element.classList.add('folder'); }
        if (row.kind === 'L' || row.kind === 'l') element.classList.add('link');
        if (row.kind === 'b') element.classList.add('broken');
        element.draggable = true;
        const meta = row.isDir ? itemCount(row.count) : humanSize(row.size);
        element.insertAdjacentHTML('beforeend',
            `<span class="twisty">${row.isDir ? icon('chevron') : ''}</span>` +
            `<span class="icon cat-${category}">${icon(iconName)}</span>` +
            `<span class="name cat-${category}"></span>` +
            (row.kind === 'L' || row.kind === 'l' || row.kind === 'b' ? `<span class="link-mark" title="Symbolic link">${icon('link')}</span>` : '') +
            (meta ? `<span class="meta">${escapeHTML(meta)}</span>` : ''));
        const name = element.querySelector('.name');
        name.textContent = printable(row.name);
        element.title = displayPath(row.path);
        return element;
    }

    function syncActiveDescendant() {
        const index = selected ? rowIndexByPath.get(selected) : undefined;
        const element = index === undefined ? null : document.getElementById(`row-${index}`);
        if (element) tree.setAttribute('aria-activedescendant', element.id);
        else tree.removeAttribute('aria-activedescendant');
    }

    function select(path, { reveal = true } = {}) {
        selected = path;
        for (const element of spacer.querySelectorAll('.row[role="treeitem"]')) {
            element.setAttribute('aria-selected', String(rows[Number(element.dataset.index)]?.path === path));
        }
        if (reveal) ensureVisible(rowIndexByPath.get(path));
        syncActiveDescendant();
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
        tree.scrollTop = 0;
        rebuild();
    }

    function moveSelection(delta) {
        if (!rows.length) return;
        let index = selected ? rowIndexByPath.get(selected) ?? -1 : -1;
        if (index === -1) index = delta > 0 ? -1 : rows.length;
        let next = Math.max(0, Math.min(rows.length - 1, index + delta));
        const step = delta > 0 ? 1 : -1;
        while (rows[next]?.note && next + step >= 0 && next + step < rows.length) next += step;
        while (rows[next]?.note && next - step >= 0 && next - step < rows.length) next -= step;
        if (rows[next] && !rows[next].note) select(rows[next].path);
    }

    async function revealPath(target) {
        if (!root || !isWithin(target, root)) return;
        const chain = [];
        for (let dir = parentOf(target); isWithin(dir, root) && dir !== root; dir = parentOf(dir)) chain.unshift(dir);
        await ensureLoaded(root);
        for (const dir of chain) {
            expanded.add(dir);
            await ensureLoaded(dir);
        }
        rebuild();
        select(target);
        const index = rowIndexByPath.get(target);
        if (index !== undefined) {
            tree.scrollTop = Math.max(0, index * ROW_HEIGHT - tree.clientHeight / 2);
            render();
            document.getElementById(`row-${index}`)?.classList.add('drop-flash');
        }
    }

    async function ensureLoaded(dir) {
        if (dirs.get(dir)?.status !== 'ready') await load(dir);
    }

    // --- Opening and terminal actions -----------------------------------------------------
    function anchorPaneID() {
        return source?.paneID ?? shellPaneID ?? null;
    }

    function terminalTarget() {
        if (source?.type === 'shell' && panesByID.has(source.paneID)) return source.paneID;
        return shellPaneID;
    }

    async function open(row, { raw = false } = {}) {
        if (row.isDir) { toggle(row); return; }
        if (row.kind === 'b') { toast('This link points to nothing.'); return; }
        // Fifos, sockets and devices: opening one would block whatever reads it.
        if (row.kind === 'o') { toast('This is not a regular file, so it is not opened.'); return; }
        let route = openRoute(row.name);
        if (raw) {
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
        const anchor = anchorPaneID();
        if (route === 'kelpi') {
            await api.files.open(row.path, { ...(anchor ? { paneID: anchor } : {}), focus: true });
        } else if (route === 'web') {
            const reply = await api.command({ command: 'web-open', url: fileURL(row.path), focus: true, ...(anchor ? { pane_id: anchor } : {}) });
            if (reply?.ok === false) throw new Error(reply.error ?? 'Kelpi could not open this file.');
        } else if (route === 'text') {
            await openInEditor(row.path);
        } else {
            await fsCall('openExternal', { path: row.path });
            toast(`Opened ${printable(row.name)}`);
        }
    }

    async function openInEditor(path) {
        assertTypable(path);
        const anchor = terminalTarget() ?? anchorPaneID();
        if (!anchor) throw new Error('Open a terminal pane first.');
        const split = await api.panes.split(anchor, { direction: 'horizontal', path: parentOf(path), focus: true });
        // Through sh, so an $EDITOR with arguments (`code --wait`) is split into words even when
        // the pane runs zsh or fish, and the path stays one argument.
        await api.terminal.send(split.paneID, `sh -c '\${VISUAL:-\${EDITOR:-vi}} "$1"' sh ${shellQuote(path)}`);
    }

    async function openTerminalAt(dir) {
        const anchor = anchorPaneID();
        if (anchor) await api.panes.split(anchor, { direction: 'horizontal', path: dir, focus: true });
        else await api.panes.create({ path: dir, focus: true });
    }

    async function insertPath(path) {
        const target = terminalTarget();
        if (!target) throw new Error('There is no terminal pane to insert into.');
        assertTypable(path);
        const pane = panesByID.get(target);
        const cwd = target === source?.paneID ? source.cwd : null;
        const shown = cwd && isWithin(path, cwd) && path !== cwd ? safeRelative(relativeTo(path, cwd)) : path;
        const text = pane?.agentKind === 'claude' && !/\s/.test(shown) ? `@${shown} ` : `${shellQuote(shown)} `;
        await api.terminal.send(target, text, { bare: true });
        const workspaceID = source?.workspaceID ?? api.context.workspaceID;
        if (workspaceID) await api.ui.focusPane(workspaceID, target).catch(() => {});
    }

    async function copyText(text, label) {
        await fsCall('copy', { text });
        toast(label);
    }

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
        prefs = { ...prefs, showHidden: !prefs.showHidden };
        savePrefs();
        updateHeader();
        reloadAll();
        if (searchOpen) runSearch(searchInput.value, 0);
        toast(prefs.showHidden ? 'Showing hidden files' : 'Hiding hidden files');
    }

    function savePrefs() {
        void api.storage.set(PREFS_KEY, prefs).catch(() => {});
    }

    const run = action => { void Promise.resolve().then(action).catch(fail); };

    // --- Context menu ---------------------------------------------------------------------
    function menuFor(row) {
        const items = [];
        if (!row) {
            items.push(
                { label: 'Copy Path', key: 'c', run: () => copyText(root, 'Copied path') },
                { label: revealLabel(), key: 'r', run: () => reveal(root) },
                { label: 'Open Terminal Here', glyph: 'terminal', run: () => openTerminalAt(root) },
                '-',
                { label: 'Refresh', run: () => reloadAll() },
                { label: 'Collapse All', run: () => collapseAll() },
                { label: prefs.pinnedRoot ? 'Unpin Folder' : 'Pin Folder', key: 'p', run: () => setPinned(prefs.pinnedRoot ? null : root) },
            );
            return items;
        }
        const target = terminalTarget();
        const claude = panesByID.get(target ?? '')?.agentKind === 'claude';
        const insert = { label: claude ? 'Mention in Claude' : 'Insert Path in Terminal', key: 'i', disabled: !target, run: () => insertPath(row.path) };
        if (row.isDir) {
            items.push(
                { label: row.open ? 'Collapse' : 'Expand', key: '⏎', run: () => toggle(row) },
                { label: 'Pin as Root', glyph: 'pin', run: () => setPinned(row.path) },
                { label: 'Open Terminal Here', glyph: 'terminal', run: () => openTerminalAt(row.path) },
            );
        } else {
            items.push(
                { label: 'Open', key: '⏎', run: () => open(row) },
                { label: 'Open in Editor', key: 'e', run: () => open(row, { raw: true }) },
                { label: 'Open with Default App', run: () => fsCall('openExternal', { path: row.path }).then(() => toast(`Opened ${printable(row.name)}`)) },
            );
        }
        items.push('-', insert,
            { label: 'Copy Path', key: 'c', run: () => copyText(row.path, 'Copied path') },
            { label: 'Copy Relative Path', key: '⇧C', run: () => copyText(relativeTo(row.path, root), 'Copied relative path') },
            '-',
            { label: revealLabel(), key: 'r', run: () => reveal(row.path) });
        return items;
    }

    function showMenu(x, y, items) {
        const menu = $('menu');
        menu.replaceChildren();
        const buttons = [];
        for (const item of items) {
            if (item === '-') { const sep = document.createElement('div'); sep.className = 'menu-sep'; sep.setAttribute('role', 'separator'); menu.append(sep); continue; }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu-item';
            button.setAttribute('role', 'menuitem');
            button.disabled = Boolean(item.disabled);
            button.innerHTML = `<span class="menu-label"></span>${item.key ? `<kbd>${escapeHTML(item.key)}</kbd>` : ''}`;
            button.querySelector('.menu-label').textContent = item.label;
            button.addEventListener('click', () => { hideMenu(); run(item.run); });
            button.addEventListener('pointerenter', () => setMenuActive(buttons.indexOf(button)));
            buttons.push(button);
            menu.append(button);
        }
        menu.hidden = false;
        const { width, height } = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
        menu.style.top = `${y + height > innerHeight - 6 ? Math.max(6, y - height) : y}px`;
        menuState = { buttons, active: -1 };
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
        menuState = null;
    }

    $('menu').addEventListener('keydown', event => {
        if (!menuState) return;
        const enabled = menuState.buttons.map((button, index) => button.disabled ? -1 : index).filter(index => index >= 0);
        const position = enabled.indexOf(menuState.active);
        if (event.key === 'ArrowDown') { event.preventDefault(); setMenuActive(enabled[(position + 1) % enabled.length]); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setMenuActive(enabled[(position - 1 + enabled.length) % enabled.length]); }
        else if (event.key === 'Escape') { event.preventDefault(); hideMenu(); tree.focus(); }
    });
    window.addEventListener('pointerdown', event => { if (menuState && !$('menu').contains(event.target)) hideMenu(); }, true);
    window.addEventListener('blur', () => { hideMenu(); pointerDown = false; });

    // --- Help -----------------------------------------------------------------------------
    const HELP = [
        ['↑ ↓  j k', 'Move'], ['← →  h l', 'Collapse / expand'], ['⏎', 'Open (folders toggle)'],
        ['e', 'Open in editor'], ['i', 'Insert path in terminal'], ['c  ⇧C', 'Copy path / relative path'],
        ['r', revealLabel()], ['/', 'Search'], ['.', 'Hidden files'], ['p', 'Pin folder'], ['?', 'This help'],
    ];
    function toggleHelp(force) {
        const help = $('help');
        const show = force ?? help.hidden;
        if (show) {
            help.innerHTML = `<h2>Keyboard</h2><dl>${HELP.map(([keys, label]) => `<dt><kbd>${escapeHTML(keys)}</kbd></dt><dd>${escapeHTML(label)}</dd>`).join('')}</dl>`;
        }
        help.hidden = !show;
    }

    // --- Search ---------------------------------------------------------------------------
    function openSearch() {
        if (!root) return;
        hideMenu();
        toggleHelp(false);
        searchOpen = true;
        $('search-bar').hidden = false;
        tree.hidden = true;
        resultsBox.hidden = false;
        searchInput.value = '';
        searchInput.focus();
        updateState();
        runSearch('', 0);
    }

    function closeSearch() {
        if (!searchOpen) return;
        searchOpen = false;
        searchSeq++;
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

    function runSearch(query, delay = 70) {
        clearTimeout(searchTimer);
        const seq = ++searchSeq;
        searchTimer = setTimeout(async () => {
            try {
                const result = await fsCall('search', { root, query, showHidden: prefs.showHidden });
                if (seq !== searchSeq || !searchOpen) return;
                searchResults = result.results.map(([relative, isDir, positions]) => ({ relative, isDir, positions }));
                searchRoot = result.root;
                resultIndex = 0;
                const note = $('search-note');
                note.textContent = result.truncated ? `Searched the first ${result.indexed.toLocaleString()} entries` : '';
                note.hidden = !result.truncated;
                renderResults();
            } catch (cause) {
                if (seq === searchSeq) fail(cause);
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

    function renderResults() {
        resultsBox.replaceChildren();
        if (!searchResults.length) {
            const empty = document.createElement('div');
            empty.className = 'result';
            empty.innerHTML = '<span class="result-dir">No matches</span>';
            resultsBox.append(empty);
            return;
        }
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
        const path = join(root, result.relative);
        closeSearch();
        await revealPath(path);
        if (!result.isDir) {
            const row = selectedRow();
            if (row) await open(row);
        }
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
        }
    });

    // --- Tree input -----------------------------------------------------------------------
    const rowFromEvent = event => {
        const element = event.target.closest?.('.row');
        return element ? rows[Number(element.dataset.index)] ?? null : null;
    };

    tree.addEventListener('pointerdown', () => { pointerDown = true; });
    // A drag ends with pointercancel and dragend, never pointerup.
    const releasePointer = () => {
        if (!pointerDown) return;
        pointerDown = false;
        if (renderAfterPointer) { renderAfterPointer = false; setTimeout(() => queueRender(true), 0); }
    };
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
    tree.addEventListener('dragend', releasePointer);
    tree.addEventListener('scroll', () => queueRender(true), { passive: true });

    tree.addEventListener('click', event => {
        hideMenu();
        const row = rowFromEvent(event);
        if (!row || row.note) return;
        select(row.path, { reveal: false });
        if (row.isDir) { if (event.detail <= 1) toggle(row); }
        else if (event.detail === 2) run(() => open(row));
    });

    tree.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (!root) return;
        const row = rowFromEvent(event);
        if (row?.note) return;
        if (row) select(row.path, { reveal: false });
        tree.focus();
        showMenu(event.clientX, event.clientY, menuFor(row));
    });

    tree.addEventListener('dragstart', event => {
        const row = rowFromEvent(event);
        if (!row || row.note) { event.preventDefault(); return; }
        if (CONTROL_CHARACTERS.test(row.path)) { event.preventDefault(); toast('This name contains control characters; copy the path instead.'); return; }
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', shellQuote(row.path));
        event.dataTransfer.setData('text/uri-list', fileURL(row.path));
    });

    tree.addEventListener('keydown', event => {
        if (event.metaKey || event.ctrlKey || event.altKey || !root) return;
        const row = selectedRow();
        const page = Math.max(1, Math.floor(tree.clientHeight / ROW_HEIGHT) - 1);
        const handled = () => { event.preventDefault(); event.stopPropagation(); };
        switch (event.key) {
            case 'ArrowDown': case 'j': handled(); moveSelection(1); break;
            case 'ArrowUp': case 'k': handled(); moveSelection(-1); break;
            case 'PageDown': handled(); moveSelection(page); break;
            case 'PageUp': handled(); moveSelection(-page); break;
            case 'Home': handled(); moveSelection(-rows.length); break;
            case 'End': handled(); moveSelection(rows.length); break;
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
            case 'i': if (row) { handled(); run(() => insertPath(row.path)); } break;
            case 'c': handled(); run(() => copyText(row?.path ?? root, 'Copied path')); break;
            case 'C': handled(); run(() => copyText(relativeTo(row?.path ?? root, root), 'Copied relative path')); break;
            case 'r': handled(); run(() => reveal(row?.path ?? root)); break;
            case '.': handled(); toggleHidden(); break;
            case '/': handled(); openSearch(); break;
            case 'p': handled(); setPinned(prefs.pinnedRoot ? null : root); break;
            case '?': handled(); toggleHelp(); break;
            case 'Escape': if (!$('help').hidden || menuState) { handled(); toggleHelp(false); hideMenu(); } break;
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

    tree.addEventListener('focus', () => {
        // Only keyboard focus picks a row; a click selects the row it lands on.
        if (!selected && rows.length && !pointerDown) {
            const first = rows.find(row => !row.note);
            if (first) select(first.path);
        }
    });

    // --- Header buttons -------------------------------------------------------------------
    $('btn-search').innerHTML = icon('search');
    $('btn-collapse').innerHTML = icon('collapse');
    $('btn-pin').innerHTML = icon('pin');
    $('search-close').innerHTML = icon('close');
    document.querySelector('.search-glyph').innerHTML = icon('search');
    document.querySelector('.root-icon').innerHTML = icon('folderOpen');
    for (const button of document.querySelectorAll('[data-tip]')) button.title = button.dataset.tip.replace(/ {2}(\S+)$/, '  ($1)');

    $('btn-search').addEventListener('click', () => (searchOpen ? closeSearch() : openSearch()));
    $('search-close').addEventListener('click', closeSearch);
    $('btn-hidden').addEventListener('click', toggleHidden);
    $('btn-collapse').addEventListener('click', collapseAll);
    $('btn-pin').addEventListener('click', () => { if (root) setPinned(prefs.pinnedRoot ? null : root); });
    $('root-path').addEventListener('dblclick', () => { if (root) run(() => copyText(root, 'Copied path')); });

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

    function onFilesChanged(changed) {
        for (const dir of changed) {
            if (typeof dir !== 'string') continue;
            if (dirs.has(dir)) queueReload(dir);
            // A folder's own item count lives in its parent's listing.
            const parent = parentOf(dir);
            if (parent !== dir && dirs.has(parent) && expanded.has(parent)) queueReload(parent);
        }
        if (searchOpen) runSearch(searchInput.value, 250);
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
            watchKey = '';
            void fsCall('release', { token: watchToken }).catch(() => {});
        }
    }

    // --- Boot -----------------------------------------------------------------------------
    let booted = false;
    async function boot() {
        await api.ready;
        applyTone();
        updateHeader();
        updateState();
        try {
            const stored = await api.storage.get(PREFS_KEY);
            if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
                prefs = {
                    showHidden: stored.showHidden !== false,
                    pinnedRoot: typeof stored.pinnedRoot === 'string' && stored.pinnedRoot.startsWith('/') ? stored.pinnedRoot : null,
                };
            }
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
        disposers.push(api.events.on('gap', () => { scheduleSourceRefresh(0); reloadAll(); }));
        disposers.push(api.events.on(CHANGED_EVENT, event => onFilesChanged(event.data?.dirs ?? [])));
        disposers.push(api.onContext(environment => {
            applyTone();
            setVisible(environment.visible !== false);
            scheduleSourceRefresh();
        }));

        const renew = setInterval(() => syncWatch(true), WATCH_RENEW_MS);
        disposers.push(() => clearTimeout(pollTimer), () => clearInterval(renew));
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
