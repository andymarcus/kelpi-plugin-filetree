/* File categories, icons and open routing. A port of filetree-cli's styles.py: a file's
   category drives both its colour (`.cat-<name>` in style.css) and its icon. */
(() => {
    const EXT_CATEGORY = new Map();
    const register = (category, ...extensions) => { for (const ext of extensions) EXT_CATEGORY.set(ext, category); };

    register('code',
        '.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.rb', '.java', '.c',
        '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.swift', '.kt', '.scala',
        '.lua', '.pl', '.r', '.dart', '.ex', '.exs', '.clj', '.hs', '.ml',
        '.vue', '.svelte', '.sql', '.mjs', '.cjs', '.css', '.scss', '.html', '.htm');
    register('docs',
        '.md', '.markdown', '.rst', '.txt', '.text', '.adoc', '.org', '.tex',
        '.pdf', '.doc', '.docx', '.rtf', '.epub');
    register('image',
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
        '.tiff', '.tif', '.heic', '.avif');
    register('config',
        '.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.env',
        '.properties', '.lock', '.editorconfig', '.gitignore', '.gitattributes',
        '.dockerignore');
    register('archive',
        '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst',
        '.jar', '.war', '.dmg', '.iso');
    register('media',
        '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac',
        '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv');
    register('data',
        '.csv', '.tsv', '.parquet', '.xls', '.xlsx', '.db', '.sqlite', '.sqlite3',
        '.xml', '.ndjson');
    register('shell', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd');
    register('binary', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.bin', '.class', '.pyc', '.wasm');

    const FILENAME_CATEGORY = new Map([
        ['dockerfile', 'config'], ['makefile', 'code'], ['cmakelists.txt', 'code'],
        ['license', 'docs'], ['readme', 'docs'], ['.gitignore', 'config'], ['.env', 'config'],
    ]);

    // Categories whose files are never worth opening in a text editor.
    const NON_TEXT_CATEGORIES = new Set(['image', 'archive', 'media', 'binary']);
    const NON_TEXT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf', '.epub', '.xls', '.xlsx', '.db', '.sqlite', '.sqlite3', '.parquet']);

    // Kelpi renders these itself: Markdown and CSV panes, and a web pane for the rest.
    const KELPI_DOCUMENT = new Set(['.md', '.markdown', '.csv', '.tsv']);
    const KELPI_WEB = new Set(['.html', '.htm', '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

    // Files a default app would run rather than display. A plain Open reveals these instead.
    const RUNNABLE_EXTENSIONS = new Set(['.jar', '.pkg', '.mpkg', '.scpt', '.scptd', '.workflow', '.action', '.terminal', '.app', '.exe', '.msi', '.com']);

    const extensionOf = name => {
        const dot = name.lastIndexOf('.');
        return dot > 0 || (dot === 0 && name.length > 1 && !name.slice(1).includes('.')) ? name.slice(dot).toLowerCase() : '';
    };

    function categoryFor(name, isDir) {
        if (isDir) return 'folder';
        const lower = name.toLowerCase();
        if (FILENAME_CATEGORY.has(lower)) return FILENAME_CATEGORY.get(lower);
        return EXT_CATEGORY.get(extensionOf(name)) ?? 'default';
    }

    /** 'kelpi' | 'web' | 'text' | 'external' | 'unknown' (sniff the bytes to decide). */
    function openRoute(name) {
        const ext = extensionOf(name);
        if (KELPI_DOCUMENT.has(ext)) return 'kelpi';
        if (KELPI_WEB.has(ext)) return 'web';
        const lower = name.toLowerCase();
        if (FILENAME_CATEGORY.has(lower)) return FILENAME_CATEGORY.get(lower) === 'binary' ? 'external' : 'text';
        if (EXT_CATEGORY.has(ext)) {
            return NON_TEXT_CATEGORIES.has(EXT_CATEGORY.get(ext)) || NON_TEXT_EXTENSIONS.has(ext) ? 'external' : 'text';
        }
        return 'unknown';
    }

    // 24px stroke icons (Lucide geometry), drawn at 16px.
    const FILE = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';
    const PATHS = {
        folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
        code: FILE + '<path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
        docs: FILE + '<path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
        image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
        config: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
        archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
        media: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
        data: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>',
        shell: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
        binary: '<rect width="4" height="6" x="14" y="14" rx="2"/><rect width="4" height="6" x="6" y="4" rx="2"/><path d="M6 20h4"/><path d="M14 10h4"/><path d="M6 14h2v6"/><path d="M14 4h2v6"/>',
        default: FILE,
        link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        chevron: '<path d="m9 18 6-6-6-6"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.43 0 8.37 2.73 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
        collapse: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
        pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
        close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
        terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    };

    const icon = (name, className = '') =>
        `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.default}</svg>`;

    const isRunnable = name => RUNNABLE_EXTENSIONS.has(extensionOf(name));

    window.FileCategories = Object.freeze({ categoryFor, openRoute, extensionOf, isRunnable, icon });
})();
