/**
 * Search in files. Uses ripgrep when it is installed (it respects .gitignore and is fast) and
 * falls back to grep. Output is streamed and the process is stopped as soon as enough matches
 * are in, so a common word in a big tree costs little.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseGrepLine, parseRipgrepLine, smartCaseIgnores } from './grep.mjs';
import { parsePatterns } from './patterns.mjs';

export const MAX_MATCHES = 400;
const MAX_PER_FILE = 20;
const TIME_LIMIT_MS = 15000;
const BYTE_BUDGET = 190 * 1024;

let ripgrep;
function findRipgrep() {
    if (ripgrep !== undefined) return ripgrep;
    const candidates = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', path.join(os.homedir(), '.cargo', 'bin', 'rg')];
    ripgrep = candidates.find(candidate => fs.existsSync(candidate)) ?? null;
    return ripgrep;
}

// token -> running child, so a newer query from the same view stops the older one.
const running = new Map();

function argsFor(tool, { root, query, regex, showHidden, prune, exclude }) {
    const excludes = parsePatterns(exclude);
    if (tool === 'rg') {
        return ['--json', '--smart-case', ...(regex ? [] : ['--fixed-strings']), '--max-count', String(MAX_PER_FILE),
            '--max-columns', '2000', '--max-filesize', '4M', '--no-messages', '--no-config',
            ...(showHidden ? ['--hidden'] : []),
            '--glob', '!.git', ...prune.flatMap(name => ['--glob', `!${name}/`]), ...excludes.flatMap(pattern => ['--glob', `!${pattern}`]),
            '--regexp', query, '--', '.'];
    }
    // grep: absolute root, since an --exclude-dir like `.*` would also skip a root named `.`.
    return ['-r', '-n', '-I', '--null', '-m', String(MAX_PER_FILE), ...(regex ? ['-E'] : ['-F']), ...(smartCaseIgnores(query) ? ['-i'] : []),
        '--exclude-dir=.git', ...prune.map(name => `--exclude-dir=${name}`),
        ...(showHidden ? [] : ['--exclude=.*', '--exclude-dir=.*']),
        ...excludes.filter(pattern => !pattern.includes('/')).flatMap(pattern => [`--exclude=${pattern}`, `--exclude-dir=${pattern}`]),
        '-e', query, '--', root];
}

/**
 * `{ results, truncated, tool }`. Each result is `{ path, line, text, ranges }` with `path`
 * relative to `root`. A search replaced by a newer one with the same token resolves empty.
 */
export function searchContent({ token, root, query, regex = false, showHidden = true, prune = [], exclude = '' }) {
    const previous = running.get(token);
    if (previous) previous.kill();
    if (!query) return Promise.resolve({ results: [], truncated: false, tool: null });
    const rg = findRipgrep();
    const tool = rg ? 'rg' : 'grep';
    const args = argsFor(tool, { root, query, regex, showHidden, prune, exclude });
    return new Promise((resolve, reject) => {
        const child = spawn(rg ?? 'grep', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        let stopped = false;
        let replaced = false;
        const results = [];
        let bytes = 0;
        let truncated = false;
        let pending = '';
        let stderr = '';
        const stop = () => { if (!stopped) { stopped = true; child.kill(); } };
        const entry = { kill: () => { replaced = true; stop(); } };
        running.set(token, entry);
        const timer = setTimeout(() => { truncated = true; stop(); }, TIME_LIMIT_MS);
        const ignoreCase = smartCaseIgnores(query);
        const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
        const take = line => {
            if (stopped || !line) return;
            const match = tool === 'rg' ? parseRipgrepLine(line) : parseGrepLine(line, regex ? '' : query, ignoreCase);
            if (!match) return;
            if (match.path.startsWith(rootPrefix)) match.path = match.path.slice(rootPrefix.length);
            bytes += Buffer.byteLength(JSON.stringify(match), 'utf8');
            if (results.length >= MAX_MATCHES || bytes > BYTE_BUDGET) { truncated = true; stop(); return; }
            results.push(match);
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop();
            for (const line of lines) take(line);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
        child.on('error', error => {
            clearTimeout(timer);
            if (running.get(token) === entry) running.delete(token);
            reject(error.code === 'ENOENT' ? new Error('Neither ripgrep nor grep is available.') : error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (running.get(token) === entry) running.delete(token);
            take(pending);
            if (replaced) { resolve({ results: [], truncated: false, tool, replaced: true }); return; }
            // Both tools exit 1 for "no matches" and 2 for errors, which includes unreadable
            // files. Only a reported problem with no results at all is worth showing.
            const detail = stderr.trim().split('\n').pop() ?? '';
            if (!stopped && code === 2 && !results.length && detail) {
                reject(new Error(regex && /regex|parse|syntax|unclosed|repetition/i.test(stderr) ? 'That is not a valid regular expression.' : detail));
                return;
            }
            resolve({ results, truncated, tool });
        });
    });
}

export function stopContentSearch(token) {
    running.get(token)?.kill();
}
