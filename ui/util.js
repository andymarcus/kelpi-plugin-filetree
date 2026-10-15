/* Pure helpers for the File Tree view: paths, quoting, formatting. No DOM and no Kelpi, so the
   unit tests load this file directly. In the view it is `window.FileTreeUtil`. */
(root => {
    const join = (dir, name) => dir === '/' ? `/${name}` : `${dir}/${name}`;
    const parentOf = path => { const index = path.lastIndexOf('/'); return index <= 0 ? '/' : path.slice(0, index); };
    const basename = path => path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    const isWithin = (path, base) => path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
    const relativeTo = (path, base) => path === base ? '.' : isWithin(path, base) ? path.slice(base === '/' ? 1 : base.length + 1) : path;

    // Control characters would reach the terminal's line editor raw (Ctrl-C, Ctrl-U, Enter, escapes).
    const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
    // Shown names draw control characters as symbols (␍ for \r), so a name cannot hide part of
    // itself. One UTF-16 unit for one, so search highlight positions still line up.
    const printable = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
        const code = char.charCodeAt(0);
        return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '␡' : '�';
    });
    // A relative path starting with - or = would read as an option or a zsh =command.
    const safeRelative = text => /^[-=]/.test(text) ? `./${text}` : text;
    const shellQuote = text => /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
    const fileURL = path => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

    /**
     * The command typed into a new split to edit `path`, optionally at `line`. It runs through
     * `sh`, so an editor with arguments (`code --wait`) is split into words even in zsh or fish,
     * and the path stays one argument. `editor` overrides $VISUAL and $EDITOR when set. GUI
     * editors take `file:line`; terminal editors take `+line`.
     */
    function editorCommand(path, line = null, editor = '') {
        const script = 'e=${3:-${VISUAL:-${EDITOR:-vi}}}; '
            + 'if [ -z "$2" ]; then exec $e "$1"; fi; '
            + 'case "${e%% *}" in '
            + '*code|*code-insiders|*codium|*cursor|*windsurf) exec $e -g "$1:$2";; '
            + '*subl|*zed|*hx|*helix|*micro|*idea|*webstorm|*pycharm|*goland|*fleet) exec $e "$1:$2";; '
            + '*) exec $e "+$2" "$1";; esac';
        const lineArgument = Number.isSafeInteger(line) && line > 0 ? String(line) : "''";
        return `sh -c ${shellQuote(script)} sh ${shellQuote(path)} ${lineArgument}${editor ? ` ${shellQuote(editor)}` : ''}`;
    }

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

    /** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
    function relativeTime(ms, now = Date.now()) {
        if (!Number.isFinite(ms)) return '';
        const seconds = Math.round((now - ms) / 1000);
        if (seconds < 45) return 'just now';
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} h ago`;
        const days = Math.round(hours / 24);
        if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
        return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    const GIT_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict', '?': 'Untracked', '!': 'Ignored' };
    // What a row's badge shows. Untracked shows U like other editors; a conflict shows `!`.
    const GIT_BADGES = { M: 'M', A: 'A', D: 'D', R: 'R', U: '!', '?': 'U' };

    /** Paths from `paths` with no ancestor also in `paths`, in their original order. */
    function outermost(paths) {
        const set = new Set(paths);
        return paths.filter(path => {
            for (let dir = parentOf(path); ; dir = parentOf(dir)) {
                if (dir !== path && set.has(dir)) return false;
                if (dir === '/') return true;
            }
        });
    }

    /** Next sort in the cycle the `s` key steps through. */
    const SORTS = ['name', 'modified', 'size', 'type'];
    const SORT_LABELS = { name: 'Name', modified: 'Date Modified', size: 'Size', type: 'Type' };
    const nextSort = sort => SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];

    const api = Object.freeze({
        join, parentOf, basename, isWithin, relativeTo, CONTROL_CHARACTERS, printable, safeRelative, shellQuote,
        fileURL, editorCommand, humanSize, itemCount, relativeTime, GIT_LABELS, GIT_BADGES, outermost, SORTS, SORT_LABELS, nextSort,
    });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FileTreeUtil = api;
})(typeof window === 'object' ? window : globalThis);
