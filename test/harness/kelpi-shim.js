/* A stand-in for the `window.kelpi` API Kelpi injects into plugin views, for the development
   harness (server.mjs). Service calls reach the real backend; Kelpi actions are recorded. */
(() => {
    const post = async (url, body) => {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const reply = await response.json();
        if (reply?.error) throw new Error(reply.error);
        return reply?.result;
    };
    const kelpi = (method, args = {}) => post('/harness/kelpi', { method, args });

    const listeners = new Map();
    const events = new EventSource('/harness/events');
    events.onmessage = message => {
        const event = JSON.parse(message.data);
        for (const listener of [...(listeners.get(event.name) ?? []), ...(listeners.get('*') ?? [])]) {
            Promise.resolve().then(() => listener(event)).catch(error => console.error('listener', error));
        }
    };

    const theme = new URLSearchParams(location.search).get('theme') === 'light'
        ? { '--kelpi-surface': '#f7f7f8', '--kelpi-bg': '#ffffff', '--kelpi-fg': '#1c1c21', '--kelpi-fg-secondary': '#5c5c66', '--kelpi-fg-tertiary': '#8c8c96', '--kelpi-border': '#e2e2e6', '--kelpi-accent': '#2f6fd6' }
        : { '--kelpi-surface': '#16161a', '--kelpi-bg': '#101013', '--kelpi-fg': '#e6e6ea', '--kelpi-fg-secondary': '#9a9aa0', '--kelpi-fg-tertiary': '#6a6a72', '--kelpi-border': '#26262d', '--kelpi-accent': '#6f9bd8' };
    for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);

    window.kelpi = Object.freeze({
        ready: Promise.resolve(),
        visible: true,
        context: { workspaceID: 'ws-1', viewID: 'andymarcus.filetree.tree' },
        onContext: () => () => {},
        snapshot: () => kelpi('state.snapshot'),
        command: payload => kelpi('command', payload),
        services: { call: (_service, _version, method, args) => post('/harness/call', { method, args }) },
        storage: { get: key => kelpi('storage.get', { key }), set: (key, value) => kelpi('storage.set', { key, value }) },
        settings: { get: () => kelpi('settings.get'), set: (key, value) => kelpi('settings.set', { key, value }) },
        events: { on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); return () => listeners.get(name).delete(listener); } },
        files: { open: (path, options) => kelpi('files.open', { path, options }), reveal: (path, options) => kelpi('files.reveal', { path, options }) },
        panes: { split: (pane, options) => kelpi('panes.split', { pane, options }), create: options => kelpi('panes.create', { options }) },
        terminal: { send: (pane, text, options) => kelpi('terminal.send', { pane, text, options }) },
        ui: { focusPane: (workspaceID, paneID) => kelpi('ui.focusPane', { workspaceID, paneID }) },
    });
})();
