import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const util = require('../ui/util.js');
const categories = require('../ui/categories.js');

test('paths', () => {
    assert.equal(util.join('/', 'a'), '/a');
    assert.equal(util.parentOf('/a/b'), '/a');
    assert.equal(util.parentOf('/a'), '/');
    assert.equal(util.relativeTo('/a/b/c', '/a'), 'b/c');
    assert.equal(util.relativeTo('/a', '/a'), '.');
    assert.equal(util.isWithin('/ab', '/a'), false);
    assert.deepEqual(util.outermost(['/a/b', '/a', '/c/d', '/e']), ['/a', '/c/d', '/e']);
});

test('quoting for the shell', () => {
    assert.equal(util.shellQuote('plain/path.txt'), 'plain/path.txt');
    assert.equal(util.shellQuote("it's here"), `'it'\\''s here'`);
    assert.equal(util.safeRelative('-rf'), './-rf');
    assert.equal(util.safeRelative('=cmd'), './=cmd');
    assert.equal(util.printable('a\rb\u007f'), 'a␍b␡');
});

/** Runs an editor command with a stand-in editor that prints its arguments, one per line. */
function editorArgs(file, line, editorName) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'editor-'));
    const editor = path.join(dir, editorName);
    fs.writeFileSync(editor, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
    try {
        return execFileSync('/bin/sh', ['-c', util.editorCommand(file, line, `${editor} --flag`)]).toString().trim().split('\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('editor command: terminal editors take +line, GUI editors file:line, paths stay whole', () => {
    assert.deepEqual(editorArgs("/tmp/a b/it's.txt", 12, 'vim'), ['--flag', '+12', "/tmp/a b/it's.txt"]);
    assert.deepEqual(editorArgs('/tmp/x.js', 3, 'code'), ['--flag', '-g', '/tmp/x.js:3']);
    assert.deepEqual(editorArgs('/tmp/x.js', 3, 'zed'), ['--flag', '/tmp/x.js:3']);
    assert.deepEqual(editorArgs('/tmp/x.js', null, 'code'), ['--flag', '/tmp/x.js']);
});

test('formatting', () => {
    assert.equal(util.humanSize(0), '0 B');
    assert.equal(util.humanSize(1536), '1.5 KB');
    assert.equal(util.itemCount(1), '1 item');
    const now = Date.UTC(2026, 9, 15);
    assert.equal(util.relativeTime(now - 10_000, now), 'just now');
    assert.equal(util.relativeTime(now - 5 * 60_000, now), '5 min ago');
    assert.equal(util.relativeTime(now - 2 * 86_400_000, now), '2 days ago');
    assert.equal(util.nextSort('type'), 'name');
});

test('open routes', () => {
    assert.equal(categories.openRoute('notes.md'), 'kelpi');
    assert.equal(categories.openRoute('page.html'), 'web');
    assert.equal(categories.openRoute('main.ts'), 'text');
    assert.equal(categories.openRoute('photo.heic'), 'external');
    assert.equal(categories.openRoute('LICENSE'), 'text');
    assert.equal(categories.openRoute('mystery'), 'unknown');
    assert.equal(categories.isRunnable('tool.jar'), true);
});
