'use strict';
/**
 * verify.js - the gate that runs before every commit.
 *
 *  1. syntax-check every JS file
 *  2. byte-compile the python watcher
 *  3. refuse to commit anything that looks like a secret
 *  4. refuse to commit keypair material
 *
 * Exit code 0 means clean. Anything else is a hard stop.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function fail(msg) {
  console.error('FAIL', msg);
  failures += 1;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const js = files.filter((f) => f.endsWith('.js'));
const py = files.filter((f) => f.endsWith('.py'));

// 1. syntax
for (const f of js) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax: ${path.relative(ROOT, f)}\n${String(e.stderr || e.message).slice(0, 300)}`);
  }
}
console.log(`js syntax ok: ${js.length} file(s)`);

// 2. python
for (const f of py) {
  try {
    execFileSync('python3', ['-m', 'py_compile', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`python syntax: ${path.relative(ROOT, f)}\n${String(e.stderr || e.message).slice(0, 300)}`);
  }
}
console.log(`python syntax ok: ${py.length} file(s)`);

// 3. secret shapes
const SECRET_PATTERNS = [
  [/[0-9a-f]{64}/i, '64-hex value (private key or api key)'],
  [/[1-9A-HJ-NP-Za-km-z]{80,}/, 'base58 blob (keypair material)'],
  [/api-key=[0-9a-f-]{20,}/i, 'inline api key in a url'],
  [/"api[_-]?key"\s*:\s*"[^"]{16,}"/i, 'inline api key assignment'],
];

for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (rel.endsWith('.lock') || rel.endsWith('package-lock.json')) continue;
  if (rel === path.join('scripts', 'verify.js')) continue; // this file names the patterns
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  for (const [re, label] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) fail(`secret-shaped string in ${rel}: ${label} -> ${m[0].slice(0, 12)}...`);
  }
}

// 4. keypair files
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (/keypair|\.key$|id\.json$/.test(rel)) fail(`keypair material must not be committed: ${rel}`);
}

if (failures) {
  console.error(`\nverify FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nverify OK - no syntax errors, no secrets, no keypairs');
