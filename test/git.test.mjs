import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeFor, parseStatus } from '../lib/git.mjs';
import { codeOf, folderCodeOf, indexStatus } from '../lib/gitrepo.mjs';

// Real `git status --porcelain=v2 -z --branch --untracked-files=normal --ignored=matching` output.
const SAMPLE = [
    '# branch.oid 1a2b3c4d5e6f',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa aaa src/a.js',
    '2 R. N... 100644 100644 100644 bbb bbb R100 src/c.js', 'src/b.js',
    '1 D. N... 100644 000000 000000 ccc 000 src/gone.js',
    '1 .D N... 100644 100644 000000 ddd ddd docs/old notes.md',
    '1 A. N... 000000 100644 100644 000 eee src/lib/new.ts',
    'u UU N... 100644 100644 100644 100644 fff ggg hhh src/conflict.js',
    '? newdir/',
    '? src/we ird.txt',
    '! build/',
    '! src/debug.log',
    '',
].join('\0');

test('parses branch headers', () => {
    const { branch } = parseStatus(SAMPLE);
    assert.deepEqual(branch, { head: 'main', oid: '1a2b3c4d5e6f', upstream: 'origin/main', ahead: 2, behind: 1 });
});

test('parses every entry kind, including renames and spaces', () => {
    const { entries, truncated } = parseStatus(Buffer.from(SAMPLE));
    assert.equal(truncated, false);
    assert.deepEqual(entries, [
        ['src/a.js', 'M', false, null],
        ['src/c.js', 'R', true, 'src/b.js'],
        ['src/gone.js', 'D', true, null],
        ['docs/old notes.md', 'D', false, null],
        ['src/lib/new.ts', 'A', true, null],
        ['src/conflict.js', 'U', false, null],
        ['newdir/', '?', false, null],
        ['src/we ird.txt', '?', false, null],
        ['build/', '!', false, null],
        ['src/debug.log', '!', false, null],
    ]);
});

test('a detached head and an unborn branch', () => {
    const { branch } = parseStatus('# branch.oid (initial)\0# branch.head (detached)\0');
    assert.equal(branch.oid, null);
    assert.equal(branch.head, null);
});

test('stops at the limit and says so, without losing a rename\'s second field', () => {
    const { entries, truncated } = parseStatus(SAMPLE, 2);
    assert.equal(entries.length, 2);
    assert.equal(truncated, true);
});

test('codeFor prefers what is on disk', () => {
    assert.equal(codeFor('.M'), 'M');
    assert.equal(codeFor('M.'), 'M');
    assert.equal(codeFor('MD'), 'D');
    assert.equal(codeFor('A.'), 'A');
    assert.equal(codeFor('AM'), 'A');
    assert.equal(codeFor('R.'), 'R');
    assert.equal(codeFor('C.'), 'A');
    assert.equal(codeFor('.T'), 'M');
});

test('indexStatus sums folders up by severity and lists deletions per folder', () => {
    const status = indexStatus(parseStatus(SAMPLE));
    assert.equal(status.changed, 8);
    assert.equal(status.folders.get('src'), 'U');
    assert.equal(status.folders.get('src/lib'), 'A');
    assert.equal(status.folders.get('docs'), 'D');
    assert.equal(status.folders.has('build'), false, 'ignored files mark no folder');
    assert.deepEqual(status.deleted.get('src'), ['gone.js']);
    assert.deepEqual(status.deleted.get('docs'), ['old notes.md']);
});

test('codeOf finds collapsed folders above a path', () => {
    const status = indexStatus(parseStatus(SAMPLE));
    assert.equal(codeOf(status, 'src/a.js'), 'M');
    assert.equal(codeOf(status, 'newdir'), '?');
    assert.equal(codeOf(status, 'newdir/sub/x.txt'), '?');
    assert.equal(codeOf(status, 'build/out/app.js'), '!');
    assert.equal(codeOf(status, 'src/clean.js'), null);
});

test('folderCodeOf: own untracked or ignored state wins, else the summary', () => {
    const status = indexStatus(parseStatus(SAMPLE));
    assert.equal(folderCodeOf(status, 'build'), '!');
    assert.equal(folderCodeOf(status, 'newdir'), '?');
    assert.equal(folderCodeOf(status, 'src'), 'U');
    assert.equal(folderCodeOf(status, 'lib'), null);
});
