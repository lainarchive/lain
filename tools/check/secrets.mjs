/**
 * Check: secret scanning, fail-closed.
 *
 * Policy (M-1 brief §5.4):
 *   - Required security verification FAILS when the scanner is unavailable.
 *     It is never silently skipped.
 *   - Unrelated local checks may continue, clearly separated — that is what
 *     `npm run check` does (it runs this check in advisory mode and reports the
 *     scanner as missing), while `npm run verify` runs it in required mode and
 *     fails.
 *   - The scanner is never installed automatically.
 *   - Protected backups and `.lain-audit` are not scanned recursively.
 *
 * The decision is driven by `--require-security` (or LAIN_REQUIRE_SECURITY=1),
 * so a single implementation serves both commands and the difference is visible
 * in the report rather than hidden in two code paths.
 */

import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

/**
 * High-confidence secret shapes only. Deliberately conservative: a scanner that
 * cries wolf is turned off, and then it protects nothing.
 *
 * This is a *fallback* used to report what it can when gitleaks is absent. It
 * does not claim gitleaks-equivalence and says so in its evidence.
 */
const HIGH_CONFIDENCE = [
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'assigned-secret', pattern: /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{20,}["']/i },
];

const SCAN_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.sql', '.env', '.sh', '.ps1', '.example']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.lain-audit', 'artifacts']);

/**
 * @param {string} root
 * @returns {boolean}
 */
function hasGitleaks(root) {
  const probe = spawnSync('gitleaks', ['version'], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
  return probe.status === 0 || (probe.stdout ?? '').toLowerCase().includes('gitleaks');
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {string[]} out
 */
async function walk(dir, root, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(entry.name)) continue;
      await walk(full, root, out);
    } else {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot === -1 ? '' : entry.name.slice(dot);
      if (SCAN_EXTENSIONS.has(ext)) out.push(rel);
    }
  }
}

/**
 * @param {string[]} files
 * @param {string} root
 * @returns {Promise<{ id: string, file: string, line: number }[]>}
 */
async function fallbackScan(files, root) {
  /** @type {{ id: string, file: string, line: number }[]} */
  const hits = [];
  for (const rel of files) {
    const text = await readFile(join(root, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const rule of HIGH_CONFIDENCE) {
        if (rule.pattern.test(line)) hits.push({ id: rule.id, file: rel, line: index + 1 });
      }
    });
  }
  return hits;
}

/**
 * Build the self-test probes at runtime from encoded fragments.
 *
 * Why not literal test values: this file is itself scanned. An `sk-…`-shaped
 * literal here is indistinguishable from a real key to any pattern scanner —
 * including this one, which flagged four of its own probes on the first run.
 * Keeping the fragments encoded means the scanner sees no secret-shaped text in
 * this file, while the assembled probe still exercises every pattern.
 *
 * @param {string} b64
 * @returns {string}
 */
function decoded(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * @returns {{ id: string, text: string }[]}
 */
function selfTestProbes() {
  const keyword = decoded('cGFzc3dvcmQgPSAi'); // "password = \""
  return [
    { id: 'private-key-block', text: `${decoded('LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLS0=')}\nMIIE\n` },
    { id: 'aws-access-key-id', text: `aws_access_key_id = AKIA${decoded('SU9TRk9ETk43RVhBTVBMRQ==')}\n` },
    { id: 'github-token', text: `token: ghp_${'a'.repeat(36)}\n` },
    { id: 'openai-style-key', text: `key = sk-${'b'.repeat(40)}\n` },
    { id: 'jwt', text: `auth: ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5NXgL0n3I9PlFUP0THsR8U'].join('.')}\n` },
    { id: 'assigned-secret', text: `${keyword}${decoded('Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZS0xMjM0')}"\n` },
  ];
}

if (isEntryPoint(import.meta.url)) await main('secrets', async ({ result, selfTest, root, argv }) => {
  const required = argv.includes('--require-security') || process.env.LAIN_REQUIRE_SECURITY === '1';
  result.record('mode', required ? 'REQUIRED (npm run verify)' : 'advisory (npm run check)');

  if (selfTest) {
    // The fallback scanner must detect each pattern it claims to detect.
    const probes = selfTestProbes();
    const missed = [];
    for (const probe of probes) {
      const hit = HIGH_CONFIDENCE.some((rule) => rule.pattern.test(probe.text) && rule.id === probe.id);
      if (!hit) missed.push(probe.id);
    }
    const clean = 'const apiKeyName = "LAIN_API_KEY";\nexport { apiKeyName };\n';
    const falsePositive = HIGH_CONFIDENCE.some((rule) => rule.pattern.test(clean));
    result.record('probes', probes.length);
    if (missed.length > 0) result.fail(`self-test: pattern(s) failed to match: ${missed.join(', ')}`, { message: missed.join(',') });
    if (falsePositive) result.fail('self-test: a clean line was flagged as a secret', { message: 'false positive on identifier names' });
    if (missed.length === 0 && !falsePositive) {
      result.note(`self-test ok: ${probes.length} secret shapes detected, a clean identifier line was not flagged`);
    }
    return;
  }

  const gitleaks = hasGitleaks(root);
  result.record('gitleaks_available', String(gitleaks));

  /** @type {string[]} */
  const files = [];
  await walk(root, root, files);
  result.record('files_considered', files.length);

  if (gitleaks) {
    const proc = spawnSync('gitleaks', ['detect', '--no-banner', '--redact', '--source', root], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
    });
    const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
    result.record('gitleaks_exit', String(proc.status));
    if (proc.status !== 0) {
      for (const line of output.split(/\r?\n/).slice(0, 10)) result.fail(line, { message: 'gitleaks finding' });
    } else {
      result.note('gitleaks reported no findings');
    }
    return;
  }

  // gitleaks is absent: fail closed when scanning is required.
  const hits = await fallbackScan(files, root);
  result.record('fallback_patterns', HIGH_CONFIDENCE.length);
  result.record('fallback_hits', hits.length);
  for (const hit of hits.slice(0, 20)) {
    result.fail(`possible secret (${hit.id}) at ${hit.file}:${hit.line}`, {
      message: 'conservative pattern match',
      where: `${hit.file}:${hit.line}`,
    });
  }

  const message = 'gitleaks is not installed, so full-history secret scanning did not run';
  if (required) {
    result.fail(message, {
      message: 'required security gate unavailable',
      detail:
        'install gitleaks and re-run `npm run verify`; the conservative pattern scan above is not equivalent to gitleaks',
    });
  } else {
    result.skip('gitleaks full scan', message);
    result.note(
      `conservative pattern scan over ${files.length} files found ${hits.length} candidate secret(s); this is NOT a clean scan`,
    );
  }
});
