import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from '../../src/memory/store.mjs';
import { StoreError } from '../../src/store/redact.mjs';

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-memory-'));
  const dbPath = join(dir, 'memory.sqlite');
  const store = openMemoryStore({ path: dbPath });
  try {
    fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('AT-P4-01: FTS5 lexical retrieval returns source, created_at, and trust', () => {
  withTempStore((store) => {
    const trusted = store.remember({
      title: 'SQLite WAL mode',
      content: 'Use WAL mode for concurrent readers and single writer.',
      kind: 'decision',
      trust: 'trusted',
      source: 'docs/architecture.md',
    });
    const untrusted = store.remember({
      title: 'SQLite pragma note',
      content: 'Unverified note mentioning WAL mode.',
      kind: 'fact',
      source: 'web:unverified',
    });

    assert.equal(trusted.trust, 'trusted');
    assert.equal(untrusted.trust, 'untrusted');

    const defaultHits = store.search('WAL mode');
    assert.equal(defaultHits.length, 1);
    assert.equal(defaultHits[0].id, trusted.id);
    assert.equal(defaultHits[0].source, 'docs/architecture.md');
    assert.ok(defaultHits[0].created_at);
    assert.equal(defaultHits[0].trust, 'trusted');

    const allHits = store.search('WAL mode', { includeUntrusted: true });
    assert.equal(allHits.length, 2);

    // Updating a record refreshes the FTS5 index and deduplicates by id.
    store.remember({
      id: trusted.id,
      title: 'SQLite journal mode',
      content: 'Switched terminology to journal mode.',
      kind: 'decision',
      trust: 'trusted',
      source: 'docs/architecture.md',
    });
    assert.equal(store.search('WAL').length, 0);
    assert.equal(store.search('journal').length, 1);
  });
});

test('AT-P4-02: supersede resolves conflicts and hides superseded records from search', () => {
  withTempStore((store) => {
    const v1 = store.remember({
      title: 'Deploy target',
      content: 'Deploy service to staging-us-east.',
      kind: 'decision',
      trust: 'trusted',
      source: 'runbook:v1',
    });

    const { superseded, current } = store.supersede(v1.id, {
      title: 'Deploy target',
      content: 'Deploy service to prod-us-west.',
      kind: 'decision',
      trust: 'trusted',
      source: 'runbook:v2',
    });

    assert.equal(superseded.id, v1.id);
    assert.equal(superseded.superseded_by, current.id);
    assert.equal(current.superseded_by, null);

    const hits = store.search('Deploy service');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, current.id);
    assert.match(hits[0].content, /prod-us-west/);

    assert.throws(
      () => store.supersede(v1.id, { title: 'x', content: 'y', source: 'runbook:v3' }),
      (err) => err instanceof StoreError && err.code === 'ALREADY_SUPERSEDED',
    );
  });
});

test('AT-P4-03: provenance tracks source, trust, timestamps, and supersede chain', () => {
  withTempStore((store) => {
    assert.equal(store.provenance('missing-id'), null);

    const first = store.remember({
      title: 'Retention window',
      content: 'Keep logs for 14 days.',
      kind: 'preference',
      trust: 'trusted',
      source: 'user:charter',
    });

    const { current: second } = store.supersede(first.id, {
      title: 'Retention window',
      content: 'Keep logs for 30 days.',
      kind: 'preference',
      trust: 'trusted',
      source: 'user:update',
    });

    const p1 = store.provenance(first.id);
    assert.ok(p1);
    assert.equal(p1.source, 'user:charter');
    assert.equal(p1.trust, 'trusted');
    assert.equal(p1.superseded_by, second.id);
    assert.deepEqual(p1.supersedes, []);

    const p2 = store.provenance(second.id);
    assert.ok(p2);
    assert.equal(p2.source, 'user:update');
    assert.equal(p2.superseded_by, null);
    assert.deepEqual(p2.supersedes, [first.id]);
  });
});

test('AT-P4-04: untrusted records are never auto-promoted and require explicit promote()', () => {
  withTempStore((store) => {
    const rec = store.remember({
      id: 'mem-untrusted',
      title: 'API endpoint',
      content: 'Endpoint is https://internal.example/v1',
      source: 'tool:scrape',
    });
    assert.equal(rec.trust, 'untrusted');

    // Re-remembering with trust: 'trusted' must not promote an untrusted record.
    const updated = store.remember({
      id: 'mem-untrusted',
      title: 'API endpoint',
      content: 'Endpoint is https://internal.example/v2',
      trust: 'trusted',
      source: 'agent:guess',
    });
    assert.equal(updated.trust, 'untrusted');

    // Superseding a trusted record with an untrusted one keeps the new record untrusted.
    const trusted = store.remember({
      title: 'Auth policy',
      content: 'Require mTLS for internal RPC.',
      kind: 'decision',
      trust: 'trusted',
      source: 'security:policy',
    });
    const { current: untrustedNext } = store.supersede(trusted.id, {
      title: 'Auth policy',
      content: 'Disable mTLS for debugging.',
      source: 'chat:unverified',
    });
    assert.equal(untrustedNext.trust, 'untrusted');
    assert.equal(store.search('mTLS').length, 0);
    assert.equal(store.search('mTLS', { includeUntrusted: true }).length, 1);

    // promote() requires non-empty approvedBy.
    assert.throws(
      () => store.promote(rec.id, { approvedBy: '   ' }),
      (err) => err instanceof StoreError && err.code === 'APPROVAL_REQUIRED',
    );

    const promoted = store.promote(rec.id, { approvedBy: 'operator:alice' });
    assert.equal(promoted.trust, 'trusted');
    assert.equal(store.search('internal.example').length, 1);
  });
});

test('AT-P4-05: secrets in title/content are redacted and residual secrets are refused', () => {
  withTempStore((store) => {
    const awsKey = ['AKIA', '1234567890ABCDEF'].join('');
    const stored = store.remember({
      title: 'Legacy config',
      content: `Found key ${awsKey} in old env`,
      trust: 'trusted',
      source: 'audit:scan',
    });
    assert.equal(stored.content.includes(awsKey), false);
    assert.match(stored.content, /\[redacted:aws_access_key_id\]/);

    // A secret in source is not redacted by redactValue({ title, content }) and must be refused.
    const ghToken = `ghp_${'a'.repeat(36)}`;
    assert.throws(
      () =>
        store.remember({
          id: 'refused-secret-mem',
          title: 'Token note',
          content: 'Clean content',
          source: `leak:${ghToken}`,
        }),
      (err) => err instanceof StoreError && err.code === 'SECRET_REFUSED',
    );
    assert.equal(store.get('refused-secret-mem'), null);
  });
});

test('AT-P4-06: graph link and bounded neighbors traversal respect trust and depth', () => {
  withTempStore((store) => {
    const a = store.remember({ id: 'n-a', title: 'Node A', content: 'Root', kind: 'entity', trust: 'trusted', source: 'graph' });
    const b = store.remember({ id: 'n-b', title: 'Node B', content: 'Hop 1', kind: 'entity', trust: 'trusted', source: 'graph' });
    const c = store.remember({ id: 'n-c', title: 'Node C', content: 'Hop 2', kind: 'entity', trust: 'trusted', source: 'graph' });
    const d = store.remember({ id: 'n-d', title: 'Node D', content: 'Untrusted', kind: 'entity', trust: 'untrusted', source: 'graph' });

    store.link(a.id, b.id, 'depends_on', { source: 'graph', trust: 'trusted' });
    store.link(b.id, c.id, 'uses', { source: 'graph', trust: 'trusted' });
    store.link(a.id, d.id, 'mentions', { source: 'graph', trust: 'untrusted' });

    const hop1 = store.neighbors(a.id, { depth: 1 });
    assert.equal(hop1.root?.id, a.id);
    assert.deepEqual(hop1.nodes.map((n) => n.id), [b.id]);
    assert.equal(hop1.edges.length, 1);

    const hop2 = store.neighbors(a.id, { depth: 2 });
    assert.deepEqual(hop2.nodes.map((n) => n.id).sort(), [b.id, c.id]);
    assert.equal(hop2.edges.length, 2);

    const withUntrusted = store.neighbors(a.id, { depth: 1, includeUntrusted: true });
    assert.deepEqual(withUntrusted.nodes.map((n) => n.id).sort(), [b.id, d.id]);

    assert.throws(
      () => store.neighbors(a.id, { depth: 4 }),
      (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
    );
    assert.throws(
      () => store.neighbors(a.id, { depth: 0 }),
      (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
    );
  });
});

test('AT-P4-07: memories and edges persist across close and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lain-memory-reopen-'));
  const dbPath = join(dir, 'memory.sqlite');
  try {
    const store1 = openMemoryStore({ path: dbPath });
    const a = store1.remember({
      id: 'persist-a',
      title: 'Persistent fact',
      content: 'Survives restart.',
      kind: 'fact',
      trust: 'trusted',
      source: 'test:reopen',
    });
    const b = store1.remember({
      id: 'persist-b',
      title: 'Linked entity',
      content: 'Also survives restart.',
      kind: 'entity',
      trust: 'trusted',
      source: 'test:reopen',
    });
    store1.link(a.id, b.id, 'related_to', { source: 'test:reopen', trust: 'trusted' });
    store1.close();

    const store2 = openMemoryStore({ path: dbPath });
    try {
      const got = store2.get('persist-a');
      assert.ok(got);
      assert.equal(got.content, 'Survives restart.');
      assert.equal(store2.search('Survives').length, 2);
      assert.equal(store2.neighbors('persist-a', { depth: 1 }).nodes.length, 1);
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
