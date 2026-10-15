import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, fold } from '../lib/fuzzy.mjs';
import { copyName, nameProblem, splitTyped } from '../lib/names.mjs';
import { compileExcludes, parsePatterns } from '../lib/patterns.mjs';
import { findRanges, parseGrepLine, parseRipgrepLine, snippet, utf16Offset } from '../lib/grep.mjs';
import { parseTrashInfo } from '../lib/trash.mjs';

test('fuzzy: an empty query keeps index order', () => {
    const entries = [['b', true], ['a.js', false]];
    assert.deepEqual(rank(entries, '', 10), [['b', true, []], ['a.js', false, []]]);
});

test('fuzzy: prefers a match in the name over one spread through parents', () => {
    const entries = [['app/main/x.ts', false], ['src/app.ts', false], ['zzz', false]];
    const results = rank(entries, 'app', 10).map(([path]) => path);
    assert.deepEqual(results, ['src/app.ts', 'app/main/x.ts']);
});

test('fuzzy: positions point at the matched characters, ignoring case and spaces', () => {
    const [[path, , positions]] = rank([['src/Button.tsx', false]], 'b tn', 10);
    assert.equal(path, 'src/Button.tsx');
    assert.deepEqual(positions.map(index => path[index].toLowerCase()), ['b', 't', 'n']);
});

test('fold keeps one UTF-16 unit per character', () => {
    assert.equal(fold('İx').length, 2);
});

test('names: problems are explained, good names pass', () => {
    assert.equal(nameProblem('ok.txt'), null);
    assert.match(nameProblem(''), /Enter a name/);
    assert.match(nameProblem('   '), /only spaces/);
    assert.match(nameProblem('..'), /not a valid name/);
    assert.match(nameProblem('a/b'), /"\/"/);
    assert.match(nameProblem('a\nb'), /control/);
    assert.match(nameProblem('x'.repeat(256)), /too long/);
});

test('names: typed paths become segments; bad segments throw', () => {
    assert.deepEqual(splitTyped('/a//b/c.txt/'), ['a', 'b', 'c.txt']);
    assert.throws(() => splitTyped('a/../b'), /not a valid name/);
    assert.throws(() => splitTyped('///'), /Enter a name/);
});

test('names: copy names count on in Finder style', () => {
    const taken = new Set(['a.txt', 'a copy.txt', 'a copy 2.txt']);
    assert.equal(copyName('a.txt', false, name => taken.has(name)), 'a copy 3.txt');
    assert.equal(copyName('a copy 2.txt', false, name => taken.has(name)), 'a copy 3.txt');
    assert.equal(copyName('.env', false, () => false), '.env copy');
    assert.equal(copyName('my.folder', true, () => false), 'my.folder copy');
});

test('patterns: names match anywhere, slashes anchor at the root', () => {
    const excluded = compileExcludes('.DS_Store, *.pyc, dist/cache, **/tmp');
    assert.equal(excluded('a/b/.DS_Store', '.DS_Store'), true);
    assert.equal(excluded('x/y.pyc', 'y.pyc'), true);
    assert.equal(excluded('dist/cache', 'cache'), true);
    assert.equal(excluded('other/dist/cache', 'cache'), false);
    assert.equal(excluded('deep/er/tmp', 'tmp'), true);
    assert.equal(excluded('tmp', 'tmp'), true);
    assert.equal(excluded('src/app.py', 'app.py'), false);
    assert.equal(compileExcludes(' , '), null);
    assert.deepEqual(parsePatterns('a, b/ ,'), ['a', 'b']);
});

test('grep: ripgrep JSON with multi-byte text maps byte offsets to characters', () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: './src/é.js' }, lines: { text: '  café = "café";\n' }, line_number: 7, submatches: [{ match: { text: 'café' }, start: 2, end: 7 }, { match: { text: 'café' }, start: 11, end: 16 }] } });
    const match = parseRipgrepLine(line);
    assert.equal(match.path, 'src/é.js');
    assert.equal(match.line, 7);
    assert.equal(match.text, 'café = "café";');
    assert.deepEqual(match.ranges.map(([start, end]) => match.text.slice(start, end)), ['café', 'café']);
});

test('grep: other message kinds and bad JSON are skipped', () => {
    assert.equal(parseRipgrepLine('{"type":"begin","data":{}}'), null);
    assert.equal(parseRipgrepLine('not json'), null);
    assert.equal(parseRipgrepLine(JSON.stringify({ type: 'match', data: { path: { bytes: 'AA==' }, lines: { text: 'x' }, line_number: 1 } })), null);
});

test('grep: long lines get a window around the first match', () => {
    const text = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;
    const result = snippet(text, [[300, 306]]);
    assert.ok(result.text.startsWith('…'));
    assert.ok(result.text.endsWith('…'));
    const [[start, end]] = result.ranges;
    assert.equal(result.text.slice(start, end), 'NEEDLE');
});

test('grep: plain grep output, with smart case', () => {
    const match = parseGrepLine('/root/a b.txt\x0012:Hello hello', 'hello', true);
    assert.equal(match.path, '/root/a b.txt');
    assert.equal(match.line, 12);
    assert.deepEqual(match.ranges, [[0, 5], [6, 11]]);
    assert.deepEqual(findRanges('Hello hello', 'hello', false), [[6, 11]]);
    assert.equal(parseGrepLine('no nul here', 'x', true), null);
    assert.equal(utf16Offset('é!', 2), 1);
});

test('trash: .trashinfo files decode their percent-encoded path', () => {
    assert.deepEqual(parseTrashInfo('[Trash Info]\nPath=/home/me/a%20b%25.txt\nDeletionDate=2026-10-15T10:00:00\n'), { path: '/home/me/a b%.txt', date: '2026-10-15T10:00:00' });
    assert.equal(parseTrashInfo('[Trash Info]\n'), null);
});
