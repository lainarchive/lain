import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCommand } from '../../src/cli/commands/memory.mjs';
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

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-memory-cli-'));
  try {
    return fn(join(dir, 'memory.db'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('memoryCommand returns usage (2) on unknown subcommand or missing arguments', () => {
  withTempDb((dbPath) => {
    const unknown = makeIo();
    assert.equal(memoryCommand({ command: 'nope', positional: [], flags: {}, io: unknown.io, dbPath }), EXIT.usage);
    assert.match(unknown.err.join('\n'), /lain memory/);

    const badAdd = makeIo();
    assert.equal(
      memoryCommand({ command: 'add', positional: [], flags: { title: 'only-title' }, io: badAdd.io, dbPath }),
      EXIT.usage,
    );

    const badSearch = makeIo();
    assert.equal(memoryCommand({ command: 'search', positional: [], flags: {}, io: badSearch.io, dbPath }), EXIT.usage);

    const badLimit = makeIo();
    assert.equal(
      memoryCommand({ command: 'search', positional: ['alpha'], flags: { limit: '0' }, io: badLimit.io, dbPath }),
      EXIT.usage,
    );

    const badShow = makeIo();
    assert.equal(memoryCommand({ command: 'show', positional: [], flags: {}, io: badShow.io, dbPath }), EXIT.usage);

    const badSupersede = makeIo();
    assert.equal(
      memoryCommand({ command: 'supersede', positional: ['m1'], flags: { title: 't' }, io: badSupersede.io, dbPath }),
      EXIT.usage,
    );

    const badLink = makeIo();
    assert.equal(
      memoryCommand({ command: 'link', positional: ['a', 'b'], flags: { source: 'cli' }, io: badLink.io, dbPath }),
      EXIT.usage,
    );
  });
});

test('memoryCommand add, search, show, supersede, and link round-trip', () => {
  withTempDb((dbPath) => {
    const addUntrusted = makeIo();
    assert.equal(
      memoryCommand({
        command: 'add',
        positional: [],
        flags: {
          id: 'mem-1',
          title: 'Untrusted note',
          content: 'alpha bravo charlie',
          source: 'user:test',
          kind: 'fact',
          json: true,
        },
        io: addUntrusted.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const added1 = JSON.parse(addUntrusted.out.join('\n'));
    assert.equal(added1.id, 'mem-1');
    assert.equal(added1.trust, 'untrusted');

    const addTrusted = makeIo();
    assert.equal(
      memoryCommand({
        command: 'add',
        positional: [],
        flags: {
          id: 'mem-2',
          title: 'Trusted decision',
          content: 'alpha delta echo',
          source: 'operator:review',
          kind: 'decision',
          trust: 'trusted',
        },
        io: addTrusted.io,
        dbPath,
      }),
      EXIT.ok,
    );
    assert.match(addTrusted.out.join('\n'), /added mem-2 \(decision, trusted\)/);

    const searchDefault = makeIo();
    assert.equal(
      memoryCommand({
        command: 'search',
        positional: ['alpha'],
        flags: { json: true },
        io: searchDefault.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const defaultHits = JSON.parse(searchDefault.out.join('\n'));
    assert.equal(defaultHits.length, 1);
    assert.equal(defaultHits[0].id, 'mem-2');

    const searchAll = makeIo();
    assert.equal(
      memoryCommand({
        command: 'search',
        positional: ['alpha'],
        flags: { 'include-untrusted': true, limit: '5', json: true },
        io: searchAll.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const allHits = JSON.parse(searchAll.out.join('\n'));
    assert.equal(allHits.length, 2);

    const linkIo = makeIo();
    assert.equal(
      memoryCommand({
        command: 'link',
        positional: ['mem-2', 'mem-1', 'references'],
        flags: { source: 'operator:review', trust: 'trusted', json: true },
        io: linkIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const edge = JSON.parse(linkIo.out.join('\n'));
    assert.equal(edge.from_id, 'mem-2');
    assert.equal(edge.to_id, 'mem-1');
    assert.equal(edge.relation, 'references');

    const supIo = makeIo();
    assert.equal(
      memoryCommand({
        command: 'supersede',
        positional: ['mem-2'],
        flags: {
          title: 'Updated decision',
          content: 'alpha foxtrot golf',
          source: 'operator:review',
          kind: 'decision',
          trust: 'trusted',
          json: true,
        },
        io: supIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const sup = JSON.parse(supIo.out.join('\n'));
    assert.equal(sup.superseded, 'mem-2');
    assert.ok(sup.current.id);

    const showNew = makeIo();
    assert.equal(
      memoryCommand({
        command: 'show',
        positional: [sup.current.id],
        flags: { json: true },
        io: showNew.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const shown = JSON.parse(showNew.out.join('\n'));
    assert.equal(shown.record.id, sup.current.id);
    assert.ok(shown.provenance.supersedes.includes('mem-2'));

    const showMissing = makeIo();
    assert.equal(
      memoryCommand({
        command: 'show',
        positional: ['does-not-exist'],
        flags: {},
        io: showMissing.io,
        dbPath,
      }),
      EXIT.failed,
    );
    assert.match(showMissing.err.join('\n'), /not found/);
  });
});

test('memoryCommand refuses secrets with exit 3', () => {
  withTempDb((dbPath) => {
    const res = makeIo();
    const code = memoryCommand({
      command: 'add',
      positional: [],
      flags: {
        title: 'Leak',
        content: ['sk', '1234567890abcdefghijklmnopqrstuvwxyz123456'].join('-'),
        source: 'user:test',
      },
      io: res.io,
      dbPath,
    });
    assert.equal(code, EXIT.refused);
    assert.match(res.err.join('\n'), /SECRET_REFUSED/);
  });
});
