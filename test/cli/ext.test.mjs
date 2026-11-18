import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extCommand } from '../../src/cli/commands/ext.mjs';
import { EXIT } from '../../src/cli/index.mjs';

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(String(line)),
      err: (line) => err.push(String(line)),
    },
  };
}

function sampleManifest(overrides = {}) {
  return {
    id: 'sample-skill',
    name: 'Sample Skill',
    version: '1.0.0',
    description: 'Reads local notes',
    kind: 'skill',
    effect_class: 'read_only',
    requested_capabilities: ['workspace.read'],
    entry: 'index.mjs',
    ...overrides,
  };
}

function withTempEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-ext-cli-'));
  try {
    const dbPath = join(dir, 'extensions.db');
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(sampleManifest()), 'utf8');
    return fn({ dir, dbPath, manifestPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('extCommand returns usage (2) on unknown subcommand and missing args', () => {
  withTempEnv(({ dbPath }) => {
    const u1 = makeIo();
    assert.equal(extCommand({ command: 'unknown', positional: [], flags: {}, io: u1.io, dbPath }), EXIT.usage);
    assert.match(u1.err.join('\n'), /lain ext validate/);

    const u2 = makeIo();
    assert.equal(extCommand({ command: 'register', positional: ['m.json'], flags: {}, io: u2.io, dbPath }), EXIT.usage);

    const u3 = makeIo();
    assert.equal(extCommand({ command: 'approve', positional: ['sample-skill'], flags: {}, io: u3.io, dbPath }), EXIT.usage);

    const u4 = makeIo();
    assert.equal(extCommand({ command: 'activate', positional: [], flags: {}, io: u4.io, dbPath }), EXIT.usage);

    const u5 = makeIo();
    assert.equal(extCommand({ command: 'revoke', positional: ['sample-skill'], flags: {}, io: u5.io, dbPath }), EXIT.usage);

    const u6 = makeIo();
    assert.equal(extCommand({ command: 'list', positional: [], flags: { state: 'bogus' }, io: u6.io, dbPath }), EXIT.usage);
  });
});

test('extCommand validate handles valid, invalid (4), and missing/unreadable (2) manifests', () => {
  withTempEnv(({ dir, manifestPath }) => {
    const okPlain = makeIo();
    assert.equal(extCommand({ command: 'validate', positional: [manifestPath], flags: {}, io: okPlain.io }), EXIT.ok);
    assert.match(okPlain.out.join('\n'), /valid sample-skill/);

    const okJson = makeIo();
    assert.equal(extCommand({ command: 'validate', positional: [manifestPath], flags: { json: true }, io: okJson.io }), EXIT.ok);
    assert.equal(JSON.parse(okJson.out.join('\n')).ok, true);

    const badPath = join(dir, 'bad-manifest.json');
    writeFileSync(badPath, JSON.stringify(sampleManifest({ entry: '../escape.mjs' })), 'utf8');
    const badIo = makeIo();
    assert.equal(extCommand({ command: 'validate', positional: [badPath], flags: {}, io: badIo.io }), EXIT.failed);
    assert.match(badIo.err.join('\n'), /invalid:/);

    const missingIo = makeIo();
    assert.equal(
      extCommand({ command: 'validate', positional: [join(dir, 'missing.json')], flags: {}, io: missingIo.io }),
      EXIT.usage,
    );
    assert.match(missingIo.err.join('\n'), /cannot read manifest file/);

    const corruptPath = join(dir, 'corrupt.json');
    writeFileSync(corruptPath, '{not-json', 'utf8');
    const corruptIo = makeIo();
    assert.equal(extCommand({ command: 'validate', positional: [corruptPath], flags: {}, io: corruptIo.io }), EXIT.usage);
  });
});

test('extCommand inspect outputs risk report (0) and fails (4) on invalid manifest', () => {
  withTempEnv(({ dir, manifestPath }) => {
    const plain = makeIo();
    assert.equal(extCommand({ command: 'inspect', positional: [manifestPath], flags: {}, io: plain.io }), EXIT.ok);
    assert.match(plain.out.join('\n'), /risk_level\s+low/);

    const elevatedPath = join(dir, 'elevated.json');
    writeFileSync(
      elevatedPath,
      JSON.stringify(sampleManifest({ id: 'writer-ext', effect_class: 'local_reversible', requested_capabilities: ['workspace.write'] })),
      'utf8',
    );
    const jsonIo = makeIo();
    assert.equal(extCommand({ command: 'inspect', positional: [elevatedPath], flags: { json: true }, io: jsonIo.io }), EXIT.ok);
    const report = JSON.parse(jsonIo.out.join('\n'));
    assert.equal(report.id, 'writer-ext');
    assert.equal(report.risk_level, 'elevated');

    const badPath = join(dir, 'invalid.json');
    writeFileSync(badPath, JSON.stringify({ id: 'BAD ID' }), 'utf8');
    const badIo = makeIo();
    assert.equal(extCommand({ command: 'inspect', positional: [badPath], flags: {}, io: badIo.io }), EXIT.failed);
    assert.match(badIo.err.join('\n'), /INVALID_MANIFEST/);
  });
});

test('extCommand lifecycle: register -> fail-closed activate (3) -> approve -> activate -> list -> revoke', () => {
  withTempEnv(({ dbPath, manifestPath }) => {
    const regIo = makeIo();
    assert.equal(
      extCommand({ command: 'register', positional: [manifestPath], flags: { source: 'local-catalog', json: true }, io: regIo.io, dbPath }),
      EXIT.ok,
    );
    assert.equal(JSON.parse(regIo.out.join('\n')).state, 'candidate');

    // Fail closed: cannot activate before approve
    const earlyAct = makeIo();
    assert.equal(extCommand({ command: 'activate', positional: ['sample-skill'], flags: {}, io: earlyAct.io, dbPath }), EXIT.refused);
    assert.match(earlyAct.err.join('\n'), /EXTENSION_NOT_APPROVED/);

    const appIo = makeIo();
    assert.equal(
      extCommand({ command: 'approve', positional: ['sample-skill'], flags: { by: 'alice', json: true }, io: appIo.io, dbPath }),
      EXIT.ok,
    );
    const approved = JSON.parse(appIo.out.join('\n'));
    assert.equal(approved.state, 'approved');
    assert.equal(approved.approved_by, 'alice');

    const actIo = makeIo();
    assert.equal(extCommand({ command: 'activate', positional: ['sample-skill'], flags: { json: true }, io: actIo.io, dbPath }), EXIT.ok);
    assert.equal(JSON.parse(actIo.out.join('\n')).state, 'active');

    const listIo = makeIo();
    assert.equal(extCommand({ command: 'list', positional: [], flags: { state: 'active', json: true }, io: listIo.io, dbPath }), EXIT.ok);
    const activeRows = JSON.parse(listIo.out.join('\n'));
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].id, 'sample-skill');

    const revIo = makeIo();
    assert.equal(
      extCommand({
        command: 'revoke',
        positional: ['sample-skill'],
        flags: { by: 'secops', reason: 'policy update', json: true },
        io: revIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const revoked = JSON.parse(revIo.out.join('\n'));
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.revoked_by, 'secops');

    // Revoked extension cannot be activated (exit 3)
    const afterRev = makeIo();
    assert.equal(extCommand({ command: 'activate', positional: ['sample-skill'], flags: {}, io: afterRev.io, dbPath }), EXIT.refused);
    assert.match(afterRev.err.join('\n'), /EXTENSION_REVOKED/);

    // Missing extension -> exit 4
    const notFound = makeIo();
    assert.equal(extCommand({ command: 'activate', positional: ['does-not-exist'], flags: {}, io: notFound.io, dbPath }), EXIT.failed);
    assert.match(notFound.err.join('\n'), /EXTENSION_NOT_FOUND/);
  });
});
