import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createItem, duplicateItem, moveItems } from '../lib/fileops.mjs';

async function sandbox(t) {
    const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'filetree-test-')));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    return dir;
}

test('create makes folders on the way and reports the topmost new item for undo', async t => {
    const dir = await sandbox(t);
    const result = await createItem({ dir, name: 'a/b/c.txt', kind: 'file' });
    assert.equal(result.path, path.join(dir, 'a/b/c.txt'));
    assert.equal(result.undo, path.join(dir, 'a'));
    assert.equal(fs.readFileSync(result.path, 'utf8'), '');
    // `a` exists now, so only `d` is new.
    const second = await createItem({ dir, name: 'a/d', kind: 'folder' });
    assert.equal(second.undo, path.join(dir, 'a/d'));
    assert.ok(fs.statSync(second.path).isDirectory());
});

test('create never replaces an existing item', async t => {
    const dir = await sandbox(t);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'keep');
    await assert.rejects(createItem({ dir, name: 'x.txt', kind: 'file' }), /"x.txt" already exists/);
    await assert.rejects(createItem({ dir, name: 'x.txt', kind: 'folder' }), /already exists/);
    await assert.rejects(createItem({ dir, name: 'x.txt/y', kind: 'file' }), /not a folder/);
    assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'keep');
});

test('move refuses to overwrite and to move a folder into itself', async t => {
    const dir = await sandbox(t);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    fs.mkdirSync(path.join(dir, 'f'));
    await assert.rejects(moveItems([{ from: path.join(dir, 'a'), to: path.join(dir, 'b') }]), /"b" already exists/);
    await assert.rejects(moveItems([{ from: path.join(dir, 'f'), to: path.join(dir, 'f/inner') }]), /into itself/);
    assert.equal(fs.readFileSync(path.join(dir, 'b'), 'utf8'), 'b');
});

test('a multi-item move that fails part way puts the moved ones back', async t => {
    const dir = await sandbox(t);
    fs.mkdirSync(path.join(dir, 'into'));
    fs.writeFileSync(path.join(dir, 'one'), '1');
    fs.writeFileSync(path.join(dir, 'two'), '2');
    fs.writeFileSync(path.join(dir, 'into', 'two'), 'taken');
    await assert.rejects(moveItems([
        { from: path.join(dir, 'one'), to: path.join(dir, 'into/one') },
        { from: path.join(dir, 'two'), to: path.join(dir, 'into/two') },
    ]), /already exists/);
    assert.equal(fs.readFileSync(path.join(dir, 'one'), 'utf8'), '1');
    assert.equal(fs.existsSync(path.join(dir, 'into/one')), false);
});

test('a rename that only changes case works on case-insensitive disks', async t => {
    const dir = await sandbox(t);
    fs.writeFileSync(path.join(dir, 'readme'), 'x');
    await moveItems([{ from: path.join(dir, 'readme'), to: path.join(dir, 'README') }]);
    assert.ok(fs.readdirSync(dir).includes('README'));
});

test('duplicate picks the next free copy name and copies folders whole', async t => {
    const dir = await sandbox(t);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
    const first = await duplicateItem({ path: path.join(dir, 'a.txt') });
    const second = await duplicateItem({ path: path.join(dir, 'a.txt') });
    assert.equal(path.basename(first.path), 'a copy.txt');
    assert.equal(path.basename(second.path), 'a copy 2.txt');
    fs.mkdirSync(path.join(dir, 'f/g'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'f/g/x'), 'x');
    const folder = await duplicateItem({ path: path.join(dir, 'f') });
    assert.equal(fs.readFileSync(path.join(folder.path, 'g/x'), 'utf8'), 'x');
});

test('paths must be absolute', async () => {
    await assert.rejects(createItem({ dir: 'relative', name: 'x', kind: 'file' }), /absolute path/);
    await assert.rejects(moveItems([{ from: '/a', to: 'b' }]), /absolute path/);
});
