import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXT_EFFECT_CLASSES,
  EXT_KINDS,
  EXT_STATES,
  ExtError,
  inspectPermissions,
  openExtensionRegistry,
  validateManifest,
} from '../../src/ext/contract.mjs';

function makeManifest(overrides = {}) {
  return {
    id: 'git-helper',
    name: 'Git Helper',
    version: '1.0.0',
    description: 'Read-only git status helper',
    kind: 'skill',
    effect_class: 'read_only',
    requested_capabilities: ['workspace.read'],
    entry: 'src/index.mjs',
    ...overrides,
  };
}

describe('Phase 6 extension contract core', () => {
  it('AT-P6-01: validates manifests and rejects path traversal, drives, and bad shapes', () => {
    assert.deepEqual(EXT_KINDS, ['skill', 'plugin', 'mcp']);
    assert.deepEqual(EXT_EFFECT_CLASSES, ['read_only', 'local_reversible', 'external']);
    assert.deepEqual(EXT_STATES, ['candidate', 'approved', 'active', 'revoked']);

    const valid = validateManifest(
      makeManifest({
        id: 'a',
        kind: 'mcp',
        description: undefined,
        requested_capabilities: ['workspace.read', 'workspace.read', 'net.http'],
        entry: './bin/server.mjs',
      }),
    );
    assert.equal(valid.ok, true);
    assert.equal(valid.manifest.description, '');
    assert.deepEqual(valid.manifest.requested_capabilities, ['workspace.read', 'net.http']);

    for (const badRaw of [null, undefined, 'str', 42, [], new Date()]) {
      const res = validateManifest(badRaw);
      assert.equal(res.ok, false);
    }

    const badEntries = [
      '',
      '../escape.mjs',
      'sub/../../escape.mjs',
      '..\\escape.mjs',
      '/etc/passwd',
      '\\Windows\\System32\\cmd.exe',
      'C:\\ext\\index.mjs',
      'C:index.mjs',
      'file://index.mjs',
      'index.mjs\0.txt',
    ];
    for (const entry of badEntries) {
      const res = validateManifest(makeManifest({ entry }));
      assert.equal(res.ok, false, `expected entry ${JSON.stringify(entry)} to fail`);
    }

    const badFields = [
      { id: '' },
      { id: '-bad' },
      { id: 'bad-' },
      { id: 'Bad_Case' },
      { id: 'a'.repeat(65) },
      { name: '   ' },
      { version: '' },
      { description: 123 },
      { kind: 'tool' },
      { effect_class: 'root' },
      { requested_capabilities: 'workspace.read' },
      { requested_capabilities: [''] },
    ];
    for (const patch of badFields) {
      const res = validateManifest(makeManifest(patch));
      assert.equal(res.ok, false, `expected patch ${JSON.stringify(patch)} to fail`);
    }
  });

  it('AT-P6-02: inspects permissions and computes risk levels', () => {
    const low = inspectPermissions(makeManifest());
    assert.deepEqual(low, {
      id: 'git-helper',
      kind: 'skill',
      effect_class: 'read_only',
      requested_capabilities: ['workspace.read'],
      risk_level: 'low',
    });

    const elevatedByEffect = inspectPermissions(makeManifest({ effect_class: 'local_reversible' }));
    assert.equal(elevatedByEffect.risk_level, 'elevated');

    const elevatedBySpawn = inspectPermissions(
      makeManifest({ effect_class: 'read_only', requested_capabilities: ['process.spawn'] }),
    );
    assert.equal(elevatedBySpawn.risk_level, 'elevated');

    const elevatedByWrite = inspectPermissions(
      makeManifest({ effect_class: 'read_only', requested_capabilities: ['workspace.write'] }),
    );
    assert.equal(elevatedByWrite.risk_level, 'elevated');

    const high = inspectPermissions(
      makeManifest({ effect_class: 'external', requested_capabilities: ['workspace.read'] }),
    );
    assert.equal(high.risk_level, 'high');

    assert.throws(
      () => inspectPermissions(makeManifest({ entry: '../bad.mjs' })),
      (err) => err instanceof ExtError && err.code === 'INVALID_MANIFEST',
    );
  });

  it('AT-P6-03: activate fails closed before approve', () => {
    const reg = openExtensionRegistry({ path: ':memory:' });
    try {
      reg.registerCandidate(makeManifest(), { source: 'local:test' });

      assert.throws(
        () => reg.activate('git-helper'),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_NOT_APPROVED',
      );

      assert.throws(
        () => reg.activate('missing-ext'),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_NOT_FOUND',
      );
    } finally {
      reg.close();
    }
  });

  it('AT-P6-04: supports full register -> approve -> activate -> revoke lifecycle', () => {
    let tick = 1_700_000_000_000;
    const reg = openExtensionRegistry({ path: ':memory:', now: () => (tick += 1000) });
    try {
      const c1 = reg.registerCandidate(makeManifest({ version: '1.0.0' }), { source: 'local:dir' });
      assert.equal(c1.state, 'candidate');
      assert.equal(c1.source, 'local:dir');

      const c2 = reg.registerCandidate(makeManifest({ version: '1.0.1' }), { source: 'local:dir-v2' });
      assert.equal(c2.state, 'candidate');
      assert.equal(c2.version, '1.0.1');
      assert.equal(c2.created_at, c1.created_at);

      const approved = reg.approve('git-helper', { approvedBy: 'operator-1' });
      assert.equal(approved.state, 'approved');
      assert.equal(approved.approved_by, 'operator-1');
      assert.ok(approved.approved_at);

      const active = reg.activate('git-helper');
      assert.equal(active.state, 'active');

      assert.throws(
        () => reg.activate('git-helper'),
        (err) => err instanceof ExtError && err.code === 'INVALID_STATE',
      );

      assert.equal(reg.list({ state: 'active' }).length, 1);
      assert.equal(reg.list({ state: 'candidate' }).length, 0);

      const revoked = reg.revoke('git-helper', { revokedBy: 'security-1', reason: 'deprecated' });
      assert.equal(revoked.state, 'revoked');
      assert.equal(revoked.revoked_by, 'security-1');
      assert.equal(revoked.revoke_reason, 'deprecated');
      assert.ok(revoked.revoked_at);
      assert.equal(reg.get('git-helper')?.state, 'revoked');
      assert.equal(reg.get('nope'), null);
    } finally {
      reg.close();
    }
  });

  it('AT-P6-05: revoked and active extensions cannot re-register or activate', () => {
    const reg = openExtensionRegistry({ path: ':memory:' });
    try {
      reg.registerCandidate(makeManifest(), { source: 'local:test' });
      reg.approve('git-helper', { approvedBy: 'op' });
      reg.activate('git-helper');

      assert.throws(
        () => reg.registerCandidate(makeManifest({ version: '2.0.0' }), { source: 'local:test' }),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_EXISTS',
      );

      reg.revoke('git-helper', { revokedBy: 'op', reason: 'unsafe' });

      assert.throws(
        () => reg.activate('git-helper'),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_REVOKED',
      );
      assert.throws(
        () => reg.registerCandidate(makeManifest({ version: '2.0.0' }), { source: 'local:test' }),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_EXISTS',
      );
      assert.throws(
        () => reg.approve('git-helper', { approvedBy: 'op' }),
        (err) => err instanceof ExtError && err.code === 'INVALID_STATE',
      );
    } finally {
      reg.close();
    }
  });

  it('AT-P6-06: persists registry state across close and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-ext-test-'));
    const dbPath = join(dir, 'nested', 'ext.sqlite');
    try {
      const reg1 = openExtensionRegistry({ path: dbPath });
      reg1.registerCandidate(makeManifest({ id: 'ext-a' }), { source: 'local:a' });
      reg1.approve('ext-a', { approvedBy: 'op' });
      reg1.activate('ext-a');
      reg1.registerCandidate(makeManifest({ id: 'ext-b', kind: 'plugin' }), { source: 'local:b' });
      reg1.revoke('ext-b', { revokedBy: 'op', reason: 'test' });
      reg1.close();

      const reg2 = openExtensionRegistry({ path: dbPath });
      try {
        const a = reg2.get('ext-a');
        const b = reg2.get('ext-b');
        assert.equal(a?.state, 'active');
        assert.equal(a?.approved_by, 'op');
        assert.equal(b?.state, 'revoked');
        assert.equal(b?.revoke_reason, 'test');
        assert.deepEqual(
          reg2.list().map((r) => r.id),
          ['ext-a', 'ext-b'],
        );
      } finally {
        reg2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P6-07: rejects whitespace/percent entry bypasses, untrimmed capabilities, and double-revoke', () => {
    assert.equal(validateManifest(makeManifest({ entry: ' ../escape.mjs' })).ok, false);
    assert.equal(validateManifest(makeManifest({ entry: '%2e%2e/escape.mjs' })).ok, false);
    assert.equal(validateManifest(makeManifest({ requested_capabilities: [' process.spawn'] })).ok, false);

    const reg = openExtensionRegistry({ path: ':memory:' });
    try {
      reg.registerCandidate(makeManifest(), { source: 'local:dir' });
      reg.revoke('git-helper', { revokedBy: 'sec-1', reason: 'initial' });
      assert.throws(
        () => reg.revoke('git-helper', { revokedBy: 'sec-2', reason: 'overwrite' }),
        (err) => err instanceof ExtError && err.code === 'EXTENSION_REVOKED',
      );
      assert.equal(reg.get('git-helper')?.revoked_by, 'sec-1');
    } finally {
      reg.close();
    }
  });
});
