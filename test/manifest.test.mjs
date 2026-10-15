/* The manifest, the backend and the view each name the same methods, commands and settings.
   These checks catch one drifting from the others, which Kelpi would only report at run time. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync(new URL('../kelpi.plugin.json', import.meta.url), 'utf8'));
const { contributes } = manifest;
const ID = manifest.id;

test('service, provider and backend agree on the methods', async () => {
    const [service] = contributes.services;
    const [provider] = contributes.providers;
    assert.deepEqual([...provider.methods].sort(), [...service.methods].sort());
    const backend = await import('../backend.mjs');
    let registered;
    const dispose = await backend.activate({
        emit: async () => {},
        providers: { register: (_id, methods) => { registered = methods; return () => {}; } },
        commands: { register: () => () => {} },
    });
    dispose();
    assert.deepEqual(Object.keys(registered).sort(), [...service.methods].sort());
});

test('every command is registered by the backend and reachable from the palette', async () => {
    const { COMMANDS } = await import('../backend.mjs');
    const declared = contributes.commands.map(command => command.id);
    assert.deepEqual([...declared].sort(), COMMANDS.map(action => `${ID}.${action}`).sort());
    const inPalette = contributes.menus.filter(menu => menu.placement === 'palette').map(menu => menu.command);
    assert.deepEqual([...inPalette].sort(), [...declared].sort());
    for (const menu of contributes.menus) assert.ok(declared.includes(menu.command), `${menu.id} names a declared command`);
});

test('the view handles every command action', () => {
    const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
    const block = app.slice(app.indexOf('const actions = {'), app.indexOf('const action = actions[data.action];'));
    for (const command of contributes.commands) {
        const action = command.id.slice(ID.length + 1);
        assert.ok(block.includes(`${/^[a-z]+$/.test(action) ? action : `'${action}'`}:`), `the view handles ${action}`);
    }
});

test('the view\'s setting defaults match the manifest', () => {
    const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
    const source = /const DEFAULT_SETTINGS = Object\.freeze\((\{[\s\S]*?\})\);/.exec(app)?.[1];
    assert.ok(source, 'DEFAULT_SETTINGS is in app.js');
    const defaults = vm.runInNewContext(`(${source})`);
    const declared = Object.fromEntries(Object.entries(contributes.settings).map(([key, setting]) => [key, setting.default]));
    assert.deepEqual({ ...defaults }, declared);
});

test('settings are well formed', () => {
    const groups = new Set(contributes.settingGroups.map(group => group.id));
    for (const [key, setting] of Object.entries(contributes.settings)) {
        assert.equal(typeof setting.default, setting.type, `${key} default type`);
        assert.ok(groups.has(setting.group), `${key} group`);
        if (setting.enum) assert.ok(setting.enum.includes(setting.default), `${key} default is a choice`);
        if (setting.min !== undefined) assert.ok(setting.default >= setting.min && setting.default <= setting.max, `${key} default in range`);
    }
});
