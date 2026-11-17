#!/usr/bin/env node
/* global console, process, URL */
/**
 * Fast test selection for the middle of a module build. The full suite stays the gate before a merge.
 *   node scripts/test-module.mjs module <name> [--explain]
 *   node scripts/test-module.mjs changed [--base <ref>] [--explain]
 *   node scripts/test-module.mjs contracts [--explain]
 * Extra arguments after `--` go to vitest. See scripts/TEST_SELECTION.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
process.chdir(ROOT);
const posix = p => p.split(sep).join('/');

// ---------- file walking and import graph ----------
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js)$/.test(name)) out.push(posix(p));
  }
  return out;
}
const SCAN = ['src', 'tests', 'seeders', 'scripts'].flatMap(d => walk(d));
const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\(\s*|vi\.(?:mock|doMock)\(\s*|import\s+)['"](\.[^'"]*)['"]/g;
function resolveImport(from, spec) {
  const base = posix(join(dirname(from), spec)).replace(/\.js$/, '');
  for (const c of [base + '.ts', base + '/index.ts', base, base + '.js']) {
    if (SCAN.includes(c)) return c;
  }
  return null;
}
const importers = new Map(); // file -> Set of files importing it
for (const f of SCAN) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const t = resolveImport(f, m[1]);
    if (t) (importers.get(t) ?? importers.set(t, new Set()).get(t)).add(f);
  }
}

const isTest = f => f.endsWith('.test.ts') && f.startsWith('tests/');
const ALL_TESTS = SCAN.filter(isTest).sort();
const moduleOf = f => (f.match(/^src\/modules\/([^/]+)\//) ?? [])[1];
const testFolders = existsSync('tests/modules') ? readdirSync('tests/modules') : [];
const HUBS = new Set([
  'src/app.ts',
  'src/server.ts',
  'src/worker.ts',
  'src/models/index.ts',
  'scripts/seed.ts',
]);
const isHub = f => HUBS.has(f) || f.startsWith('seeders/');

// Walk importers of `start` through files accepted by `pass`; collect everything reached.
function reverseClosure(start, pass) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    for (const imp of importers.get(f) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (pass(imp)) queue.push(imp);
    }
  }
  return seen;
}

// ---------- selection ----------
const WIDE_HELPER = 40; // a helper used by more tests than this is not expanded
const WIDE_SHARED = 40; // a shared file whose importing modules own more test files than this is not expanded
const WIDE_PORT = 40; // a port file whose consumer modules own more test files than this is not expanded
const warnings = [];
const plan = new Map(); // test file -> Set of reasons
function add(file, why) {
  if (!existsSync(file)) return;
  (plan.get(file) ?? plan.set(file, new Set()).get(file)).add(why);
}
function addFolder(name, why) {
  if (!testFolders.includes(name)) return false;
  for (const t of ALL_TESTS) if (t.startsWith(`tests/modules/${name}/`)) add(t, why);
  return true;
}
function addContracts() {
  for (const line of readFileSync('scripts/test-contract-list.txt', 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [file, reason] = line.split(' # ');
    add(file.trim(), `contract: ${(reason ?? '').trim()}`);
  }
}
const BASELINE = ['access-control', 'auth'];
function addBaseline(why) {
  for (const m of BASELINE) addFolder(m, why);
}
function addTestsReaching(file, why, pass) {
  for (const f of reverseClosure(file, pass)) if (isTest(f)) add(f, why);
}
const isPortFile = f =>
  /(^|\/)(public|[\w-]+\.ports?|[\w-]+\.public)\.ts$/.test(f) || f.endsWith('/public.ts');

function tablesOfMigration(file) {
  const text = readFileSync(file, 'utf8');
  return [
    ...text.matchAll(
      /(?:createTable|addColumn|addIndex|changeColumn|removeColumn|dropTable|addConstraint)\(\s*['"](\w+)['"]/g,
    ),
  ].map(m => m[1]);
}
function modelsOfTable(table) {
  return SCAN.filter(
    f =>
      f.startsWith('src/models/') &&
      new RegExp(`tableName:\\s*['"]${table}['"]`).test(readFileSync(f, 'utf8')),
  );
}

function selectForFile(f) {
  const why = `changed ${f}`;
  if (/^(package-lock\.json|vitest\.config\.mts|tsconfig.*\.json|\.env(\.test)?)$/.test(f))
    return void (full = f);
  if (isTest(f)) return add(f, `${why} (test itself)`);
  if (f.startsWith('tests/')) {
    // helper or support file: tests that import it, directly or through other helpers
    const users = [...reverseClosure(f, x => !isTest(x))].filter(isTest);
    if (users.length > WIDE_HELPER) {
      warnings.push(
        `${f} is used by ${users.length} test files (over ${WIDE_HELPER}): not expanded. Run the full suite if the change is not additive.`,
      );
      return;
    }
    return users.forEach(t => add(t, `${why} (test helper)`));
  }
  const mod = moduleOf(f);
  if (mod) {
    addFolder(mod, `${why} (own module)`);
    // tests of other folders that import this module's files (e.g. dev hooks), within the module only
    addTestsReaching(f, `${why} (imported by test)`, x => moduleOf(x) === mod);
    if (isPortFile(f)) {
      const consumers = new Set([...(importers.get(f) ?? [])].map(moduleOf).filter(m => m && m !== mod));
      const reach = ALL_TESTS.filter(t => consumers.has(t.split('/')[2])).length;
      if (reach > WIDE_PORT) {
        warnings.push(
          `${f} is used by ${consumers.size} modules (${reach} test files, over ${WIDE_PORT}): consumers not expanded, contracts cover it.`,
        );
        consumers.clear();
      }
      for (const imp of importers.get(f) ?? []) {
        if (isTest(imp)) add(imp, `${why} (port imported by test)`);
        const m2 = moduleOf(imp);
        if (m2 && consumers.has(m2)) addFolder(m2, `${why} (port/public of ${mod}, consumed by ${m2})`);
      }
    }
    return;
  }
  if (isHub(f) && !f.startsWith('seeders/')) {
    addBaseline(`${why} (hub file)`);
    return;
  }
  if (f.startsWith('seeders/')) {
    addTestsReaching(f, `${why} (seeder)`, () => false);
    const stem = f
      .replace(/^seeders\//, '')
      .replace(/\.ts$/, '')
      .split('-')[0];
    addFolder(stem, `${why} (seeder of ${stem})`);
    return;
  }
  if (f.startsWith('migrations/')) {
    addBaseline(`${why} (migration)`);
    for (const table of tablesOfMigration(f))
      for (const model of modelsOfTable(table)) selectShared(model, `${why} -> model ${model}`);
    return;
  }
  if (/^src\/(lib|utils|middlewares|models|types|adapters|config)\//.test(f)) {
    if (/^src\/(lib|middlewares|models|types)\//.test(f)) addBaseline(`${why} (shared code)`);
    return selectShared(f, why);
  }
}
// Shared file: modules whose files import it (through other shared files), plus tests importing it.
function selectShared(file, why) {
  const reached = reverseClosure(file, x => !moduleOf(x) && !isTest(x) && !isHub(x));
  const mods = new Set([...reached].map(moduleOf).filter(Boolean));
  const reach = ALL_TESTS.filter(t => mods.has(t.split('/')[2])).length;
  if (reach > WIDE_SHARED) {
    warnings.push(
      `${file} is imported by ${mods.size} modules (${reach} test files, over ${WIDE_SHARED}): not expanded, only the baseline and contracts run. Run the full suite unless the change is additive.`,
    );
    return;
  }
  for (const x of reached) {
    const m = moduleOf(x);
    if (m) addFolder(m, `${why} (imported by module ${m})`);
    if (isTest(x)) add(x, `${why} (imported by test)`);
  }
}

// ---------- commands ----------
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd === -1 ? argv : argv.slice(0, dd);
const vitestArgs = dd === -1 ? [] : argv.slice(dd + 1);
const cmd = own[0];
const explain = own.includes('--explain');
const baseIdx = own.indexOf('--base');
const base = baseIdx !== -1 ? own[baseIdx + 1] : null;
const rest = own
  .slice(1)
  .filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--base' && arr[i - 1] !== '--head');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
}
let full = null;
if (cmd === 'module') {
  const name = rest[0];
  if (!name) {
    console.error(`usage: test:module -- <name>. Folders: ${testFolders.join(', ')}`);
    process.exit(2);
  }
  const key = name.replace(/^src\/modules\//, '').replace(/\/$/, '');
  if (key === 'health') add('tests/health.test.ts', 'module health');
  else if (!addFolder(key, `module ${key}`)) {
    // module without its own test folder (for example dev): tests that import its files
    const files = SCAN.filter(f => moduleOf(f) === key);
    if (!files.length) {
      console.error(`unknown module "${name}". Folders: ${testFolders.join(', ')}`);
      process.exit(2);
    }
    for (const f of files)
      addTestsReaching(f, `module ${key} (no test folder; tests importing it)`, x => moduleOf(x) === key);
  }
  if (!own.includes('--no-contracts')) addContracts();
} else if (cmd === 'changed') {
  const b = base ?? 'dev';
  // --head <ref> replays a past commit range (working tree ignored); the default is HEAD plus the working tree.
  const hi = own.indexOf('--head');
  const head = hi !== -1 ? own[hi + 1] : null;
  const changed = new Set(
    head
      ? git('diff', '--name-only', `${b}...${head}`)
      : [
          ...git('diff', '--name-only', `${b}...HEAD`),
          ...git('diff', '--name-only', 'HEAD'),
          ...git('ls-files', '--others', '--exclude-standard'),
        ],
  );
  const list = [...changed].sort();
  console.log(`base ${b}: ${list.length} changed files`);
  for (const f of list) {
    const r = selectForFile(f);
    if (r?.full) full = r.full;
  }
  addContracts();
} else if (cmd === 'contracts') {
  addContracts();
} else {
  console.error(
    'usage: test-module.mjs module <name> | changed [--base <ref>] [--head <ref>] | contracts  [--explain] [-- vitest args]',
  );
  process.exit(2);
}

if (full)
  warnings.unshift(
    `FULL SUITE RECOMMENDED: ${full} affects every test. The selection below is only a smoke run.`,
  );
const files = [...plan.keys()].filter(f => existsSync(f)).sort();
for (const w of warnings) console.log(`WARNING: ${w}`);
console.log(`\nselected ${files.length} of ${ALL_TESTS.length} test files`);
for (const f of files) {
  const reasons = [...plan.get(f)];
  console.log(
    `  ${f}\n      ${reasons.slice(0, 2).join(' | ')}${reasons.length > 2 ? ` (+${reasons.length - 2} more)` : ''}`,
  );
}
if (explain || !files.length) process.exit(0);
const res = spawnSync('npx', ['vitest', 'run', ...files, ...vitestArgs], { stdio: 'inherit' });
process.exit(res.status ?? 1);
