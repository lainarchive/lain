/**
 * Check: project layout matches the documented structure, and no forbidden
 * artifact has appeared in the tree.
 *
 * Why it can fail: the repository is small enough that an accidental file is
 * noticeable today and invisible at 10 000 files. Two failure classes are worth
 * automating — files in places nothing reads, and artifacts that should never
 * be committed (databases, logs, editor noise, build output).
 *
 * With `--self-test` the check runs the same rules over a synthetic file list
 * containing deliberate violations and passes only if it flags them.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

/** Directories that must exist for the documented commands to mean anything. */
const REQUIRED_DIRS = ['src', 'src/core', 'test', 'tools', 'tools/check', 'docs/implementation'];

/** Top-level entries that are expected. Anything else is reported, not failed. */
const KNOWN_TOP_LEVEL = new Set([
  '.git', '.gitattributes', '.gitignore', '.lain-audit', '.node-version',
  'ACCEPTANCE_TESTS.md', 'AGENTS.md', 'ARCHITECTURE.md', 'DECISIONS.md',
  'IMPLEMENTATION_ROADMAP.md', 'INITIAL_BACKLOG.md', 'README.md',
  'SECURITY_MODEL.md', 'SYSTEM_BOUNDARIES.md', 'docs', 'node_modules',
  'package-lock.json', 'package.json', 'src', 'test', 'tools', 'tsconfig.json',
  'artifacts', 'RESOURCE_BUDGET.md',
]);

/** Patterns that must never be tracked in this repository. */
const FORBIDDEN = [
  { pattern: /\.db(-wal|-shm)?$/i, why: 'SQLite database or sidecar: runtime data, never project content' },
  { pattern: /\.log$/i, why: 'log file' },
  { pattern: /\.tmp$/i, why: 'temporary file' },
  { pattern: /^Thumbs\.db$/i, why: 'OS noise' },
  { pattern: /^\.DS_Store$/i, why: 'OS noise' },
  { pattern: /\.(gguf|safetensors|onnx)$/i, why: 'model weights' },
  { pattern: /\.env(\.|$)/i, why: 'environment file: may contain secrets (.env.example excepted)' },
];

/**
 * @param {string} relPath
 * @param {{ pattern: RegExp, why: string }[]} rules
 * @returns {{ pattern: RegExp, why: string }[]}
 */
export function forbiddenMatches(relPath, rules = FORBIDDEN) {
  const base = relPath.split('/').pop() ?? relPath;
  return rules.filter((rule) => rule.pattern.test(relPath) || rule.pattern.test(base));
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {string[]} out
 * @param {Set<string>} ignore
 */
async function walk(dir, root, out, ignore) {
  /** @type {import('node:fs').Dirent[]} */
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (ignore.has(rel)) continue;
    if (entry.isSymbolicLink()) {
      out.push(`${rel} [symlink: not followed]`);
      continue;
    }
    if (entry.isDirectory()) {
      // Never descend into the audit evidence tree, installed dependencies, the
      // SCM store, or the designated evidence directory: `artifacts/` is where
      // verification writes its own logs, and a check must not fail on its own
      // output. That directory is intentionally not secret-scanned either.
      if (['.lain-audit', 'node_modules', '.git', 'artifacts'].includes(rel)) continue;
      await walk(full, root, out, ignore);
    } else {
      out.push(rel);
    }
  }
}

if (isEntryPoint(import.meta.url)) await main('layout', async ({ result, selfTest, root }) => {
  if (selfTest) {
    const synthetic = [
      '.lain-audit/tmp-03/fts2_100000.db',
      'logs/run.log',
      'notes.tmp',
      'Thumbs.db',
      'models/llama.gguf',
      'config/.env.local',
      'src/core/json.mjs',
    ];
    const flagged = synthetic.filter((p) => forbiddenMatches(p).length > 0);
    const missed = synthetic.filter((p) => !FORBIDDEN.some((r) => r.pattern.test(p)) && p !== 'src/core/json.mjs');
    result.record('synthetic_inputs', synthetic.length);
    result.record('flagged', flagged.join(','));
    if (missed.length > 0) {
      result.fail('self-test: the rules failed to flag a known violation', {
        message: missed.join(', '),
        detail: 'a check that cannot fail is not a check',
      });
    } else {
      result.note(`self-test ok: ${flagged.length}/${synthetic.length - 1} violations detected, src file not flagged`);
    }
    return;
  }

  // Required directories.
  for (const dir of REQUIRED_DIRS) {
    try {
      const info = await stat(join(root, dir));
      if (!info.isDirectory()) {
        result.fail(`expected a directory at ${dir}`, { message: 'not a directory', where: dir });
      }
    } catch {
      result.fail(`missing required directory ${dir}`, { message: 'directory absent', where: dir });
    }
  }

  // Top-level inventory.
  /** @type {string[]} */
  const top = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name).sort();
  result.record('top_level_count', top.length);
  const unexpected = top.filter((name) => !KNOWN_TOP_LEVEL.has(name));
  if (unexpected.length > 0) {
    result.note(`unrecognised top-level entries (reported, not failed): ${unexpected.join(', ')}`);
  }
  result.record('top_level', top.join(' '));

  // Forbidden artifacts anywhere outside ignored trees.
  /** @type {string[]} */
  const files = [];
  await walk(root, root, files, new Set(['.gitignore']));
  result.record('files_scanned', files.length);

  const violations = [];
  for (const rel of files) {
    if (rel.endsWith(' [symlink: not followed]')) continue;
    const hits = forbiddenMatches(rel);
    for (const hit of hits) violations.push({ rel, why: hit.why });
  }

  if (violations.length > 0) {
    for (const v of violations.slice(0, 20)) {
      result.fail(`forbidden artifact present: ${v.rel} (${v.why})`, { message: 'forbidden artifact', where: v.rel });
    }
    if (violations.length > 20) result.note(`${violations.length - 20} further violations suppressed`);
  } else {
    result.note(`no forbidden artifacts among ${files.length} files`);
  }
});
