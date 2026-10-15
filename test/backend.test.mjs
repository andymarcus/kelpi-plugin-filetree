/* The backend end to end, through the provider methods the view calls, on a real git repo. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findGit } from '../lib/gitrepo.mjs';

let provider;
let commands;
let dispose;
let repo;
const events = [];

const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); fs.writeFileSync(path.join(repo, relative), text); };
const names = result => result.entries.map(([name]) => name);
const codes = result => Object.fromEntries(result.entries.map(([name, , , , , code]) => [name, code]));

before(async () => {
    repo = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'filetree-repo-')));
    if (await findGit()) {
        git('init', '-q', '-b', 'main');
        write('.gitignore', 'build/\n*.log\n');
        write('src/a.js', 'a\n');
        write('src/b.js', 'b\n');
        write('src/gone.js', 'gone\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/a.js', 'changed\n');
        fs.rmSync(path.join(repo, 'src/gone.js'));
        write('src/new.js', 'new\n');
        write('build/out.js', 'out\n');
        write('debug.log', 'log\n');
    }
    const backend = await import('../backend.mjs');
    commands = new Map();
    dispose = await backend.activate({
        emit: async (name, data) => { events.push([name, data]); },
        providers: { register: (_id, methods) => { provider = methods; return () => {}; } },
        commands: { register: (id, handler) => { commands.set(id, handler); return () => commands.delete(id); } },
    });
});

after(async () => {
    dispose?.();
    await fsp.rm(repo, { recursive: true, force: true });
});

test('lists with git codes, folder summaries and deleted files', async t => {
    if (!await findGit()) { t.skip('git is not installed'); return; }
    const top = await provider.list({ path: repo, root: repo });
    assert.deepEqual(names(top), ['.git', 'build', 'src', '.gitignore', 'debug.log']);
    assert.deepEqual(codes(top), { '.git': '!', build: '!', src: 'D', '.gitignore': null, 'debug.log': '!' });
    assert.equal(top.repo.branch, 'main');
    assert.equal(top.repo.changed, 3);

    const src = await provider.list({ path: path.join(repo, 'src'), root: repo });
    assert.deepEqual(codes(src), { 'a.js': 'M', 'b.js': null, 'new.js': '?', 'gone.js': 'D' });
    assert.equal(src.entries.find(([name]) => name === 'gone.js')[1], 'x');
});

test('hides ignored files when asked, in listings and in search', async t => {
    if (!await findGit()) { t.skip('git is not installed'); return; }
    const top = await provider.list({ path: repo, root: repo, hideIgnored: true });
    assert.deepEqual(names(top), ['src', '.gitignore']);
    const search = await provider.search({ root: repo, query: 'out', hideIgnored: true });
    assert.deepEqual(search.results, []);
    const all = await provider.search({ root: repo, query: 'out', hideIgnored: false });
    assert.deepEqual(all.results.map(([relative]) => relative), ['build/out.js']);
});

test('always-hide patterns and sorting', async () => {
    const hidden = await provider.list({ path: repo, root: repo, exclude: '*.log, build', gitStatus: false });
    assert.equal(names(hidden).includes('debug.log'), false);
    assert.equal(names(hidden).includes('build'), false);
    const bySize = await provider.list({ path: path.join(repo, 'src'), root: repo, sort: 'size', gitStatus: false });
    assert.equal(names(bySize)[0], 'a.js', 'largest first');
});

test('text search finds lines with their numbers', async () => {
    const result = await provider.grep({ token: 'test', root: repo, query: 'changed' });
    assert.deepEqual(result.results.map(({ path: file, line, text }) => [file, line, text]), [['src/a.js', 1, 'changed']]);
});

test('preview reads the first lines of text files only', async () => {
    const text = await provider.preview({ path: path.join(repo, 'src/a.js') });
    assert.deepEqual(text.lines, ['changed']);
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const binary = await provider.preview({ path: path.join(repo, 'bin.dat') });
    assert.equal(binary.binary, true);
    fs.rmSync(path.join(repo, 'bin.dat'));
});

test('commands refuse to run with no File Tree on screen, and reach it when there is one', async () => {
    const reveal = commands.get('andymarcus.filetree.reveal');
    await assert.rejects(reveal({}, {}), /Show File Tree in a sidebar first/);
    provider.watch({ token: 'view', dirs: [repo] });
    await reveal({}, { paneID: 'p1' });
    assert.deepEqual(events.at(-1), ['command', { action: 'reveal', paneID: 'p1', workspaceID: null }]);
    provider.release({ token: 'view' });
});
