#!/usr/bin/env node
/**
 * Fast checks before a commit or release: every script parses, the manifest is valid JSON,
 * and, when the Kelpi CLI is installed, Kelpi itself validates the plugin.
 *
 *   node scripts/check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const fail = message => { failed = true; console.error(`✗ ${message}`); };

function* scripts(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* scripts(full);
        else if (/\.(m?js)$/.test(entry.name)) yield full;
    }
}

let count = 0;
for (const file of scripts(root)) {
    count++;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (error) { fail(`${path.relative(root, file)} does not parse:\n${error.stderr}`); }
}
console.log(`✓ ${count} scripts parse`);

try { JSON.parse(fs.readFileSync(path.join(root, 'kelpi.plugin.json'), 'utf8')); console.log('✓ kelpi.plugin.json is valid JSON'); }
catch (error) { fail(`kelpi.plugin.json: ${error.message}`); }

const kelpi = spawnSync('kelpi', ['plugin', 'validate', root, '--json'], { encoding: 'utf8' });
if (kelpi.error?.code === 'ENOENT') console.log('- kelpi is not installed; skipped `kelpi plugin validate`');
else if (kelpi.status !== 0) fail(`kelpi plugin validate:\n${kelpi.stderr || kelpi.stdout}`);
else console.log('✓ kelpi plugin validate');

process.exit(failed ? 1 : 0);
