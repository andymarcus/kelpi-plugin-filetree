/**
 * Development harness: serves the File Tree view in an ordinary browser, against the real
 * backend, with a stand-in for Kelpi's `window.kelpi`. Useful for working on the UI and for
 * driving it with Playwright.
 *
 *   node test/harness/server.mjs [--root <folder>] [--port 4173] [--light]
 *
 * The stand-in reports one workspace with one terminal pane in `--root`. Kelpi actions the
 * view takes (opening files, sending text to a terminal, opening a diff) are recorded instead
 * of performed; GET /harness/log lists them. POST /harness/command {"action": "..."} runs a
 * plugin command the way Kelpi's palette would, and POST /harness/focus {"type", "filePath"}
 * pretends a different pane took focus.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'kelpi.plugin.json'), 'utf8'));
const PLUGIN = manifest.id;

const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1]; };
const rootDir = path.resolve(option('root', process.cwd()));
const port = Number(option('port', 4173));
const light = process.argv.includes('--light');

// --- The backend, with a stand-in for its Kelpi API -------------------------------------
const clients = new Set();
function broadcast(name, data, pluginID = PLUGIN) {
    const payload = `data: ${JSON.stringify({ name, data, pluginID })}\n\n`;
    for (const client of clients) client.write(payload);
}
let provider = null;
const commands = new Map();
const backend = await import(path.join(pluginDir, manifest.backend));
await backend.activate({
    emit: async (name, data) => broadcast(`${PLUGIN}.${name}`, data),
    providers: { register: (_id, methods) => { provider = methods; return () => {}; } },
    commands: { register: (id, handler) => { commands.set(id, handler); return () => commands.delete(id); } },
});

// --- Kelpi state the view reads ----------------------------------------------------------
const storage = {};
const settings = Object.fromEntries(Object.entries(manifest.contributes.settings).map(([key, setting]) => [key, setting.default]));
const log = [];
const shellPane = { id: '00000000-0000-4000-8000-000000000001', type: 'shell', title: 'zsh', workingDirectory: rootDir, agentKind: null };
let focused = shellPane;
const snapshot = () => ({
    state: {
        lastActiveWorkspaceID: 'ws-1',
        workspaces: [{ id: 'ws-1', focusedPaneID: focused.id, panes: focused === shellPane ? [shellPane] : [shellPane, focused] }],
    },
});

const readBody = request => new Promise(resolve => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
});
const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value ?? null));
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
        if (url.pathname === '/harness/events') {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            response.write(': connected\n\n');
            clients.add(response);
            request.on('close', () => clients.delete(response));
            return;
        }
        if (url.pathname === '/harness/call' && request.method === 'POST') {
            const { method, args } = await readBody(request);
            if (typeof provider?.[method] !== 'function') { json(response, { error: `unknown method ${method}` }, 400); return; }
            try { json(response, { result: await provider[method](args ?? {}) }); }
            catch (error) { json(response, { error: error?.message ?? String(error) }); }
            return;
        }
        if (url.pathname === '/harness/kelpi' && request.method === 'POST') {
            const { method, args } = await readBody(request);
            const result = await kelpi(method, args ?? {});
            json(response, { result });
            return;
        }
        if (url.pathname === '/harness/log') { json(response, log); return; }
        if (url.pathname === '/harness/command' && request.method === 'POST') {
            const { action } = await readBody(request);
            const handler = commands.get(`${PLUGIN}.${action}`);
            if (!handler) { json(response, { error: 'unknown command' }, 400); return; }
            try { json(response, { result: await handler({}, { paneID: focused.id, workspaceID: 'ws-1' }) }); }
            catch (error) { json(response, { error: error.message }); }
            return;
        }
        if (url.pathname === '/harness/focus' && request.method === 'POST') {
            const { type = 'shell', filePath = null } = await readBody(request);
            focused = type === 'shell' ? shellPane
                : { id: '00000000-0000-4000-8000-000000000002', type, title: path.basename(filePath ?? ''), workingDirectory: filePath ? path.dirname(filePath) : rootDir, filePath, agentKind: null };
            broadcast('state.changed', null, undefined);
            json(response, { ok: true });
            return;
        }
        // The view's own files, with the stand-in injected ahead of its scripts.
        const relative = url.pathname === '/' ? 'ui/index.html' : url.pathname.replace(/^\/+/, '');
        const file = relative === 'harness/kelpi-shim.js' ? path.join(here, 'kelpi-shim.js') : path.join(pluginDir, relative);
        if (!file.startsWith(pluginDir + path.sep)) { response.writeHead(403).end(); return; }
        let body = fs.readFileSync(file);
        if (relative === 'ui/index.html') {
            body = body.toString('utf8')
                .replace('<script src="util.js"', `<script src="/harness/kelpi-shim.js"></script>\n  <script src="util.js"`)
                .replace(/(href|src)="(?!\/|https?:)([^"]+)"/g, '$1="/ui/$2"');
        }
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        response.end(body);
    } catch (error) {
        response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error?.message ?? error));
    }
});

/** Kelpi API methods the view calls, beyond the plugin service. */
async function kelpi(method, args) {
    switch (method) {
        case 'state.snapshot': return snapshot();
        case 'storage.get': return storage[args.key] ?? null;
        case 'storage.set': storage[args.key] = args.value; return null;
        case 'settings.get': return { ...settings };
        case 'settings.set':
            settings[args.key] = args.value;
            broadcast('settings.changed', { key: args.key, value: args.value });
            return null;
        case 'theme': return { light };
        default:
            log.push({ method, args, at: Date.now() });
            if (method === 'panes.split') return { paneID: 'split-pane' };
            if (method === 'command') return { ok: true };
            return null;
    }
}

server.listen(port, () => {
    console.log(`File Tree harness: http://localhost:${port}/  (root ${rootDir})`);
});
