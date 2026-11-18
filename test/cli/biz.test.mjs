import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bizCommand } from '../../src/cli/commands/biz.mjs';
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

function sampleOpportunity(overrides = {}) {
  return {
    id: 'opp-p8-1',
    title: 'Local-first invoice triage',
    category: 'workflow-automation',
    hypothesis: 'SMBs pay $49/mo to eliminate manual PDF invoice entry.',
    assumptions: ['Average SMB processes 120 invoices/month'],
    risks: ['OCR accuracy on scanned receipts'],
    validation_plan: ['Interview 10 bookkeepers and test 50 sample PDFs'],
    sources: ['customer-interviews-2026'],
    economics: {
      price_usd: 49,
      unit_cost_usd: 4,
      fixed_cost_usd: 900,
      estimated_units: 100,
    },
    ...overrides,
  };
}

function withTempEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-biz-cli-'));
  try {
    const dbPath = join(dir, 'biz.db');
    const oppPath = join(dir, 'opportunity.json');
    writeFileSync(oppPath, JSON.stringify(sampleOpportunity()), 'utf8');
    return fn({ dir, dbPath, oppPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bizCommand returns usage (2) on unknown subcommand, bare --lain-home, bad files, and invalid flags', () => {
  withTempEnv(({ dir, dbPath, oppPath }) => {
    const uUnknown = makeIo();
    assert.equal(bizCommand({ command: 'unknown', positional: [], flags: {}, io: uUnknown.io, dbPath }), EXIT.usage);
    assert.match(uUnknown.err.join('\n'), /lain biz create/);

    const uBare1 = makeIo();
    assert.equal(bizCommand({ command: 'list', positional: [], flags: { 'lain-home': true }, io: uBare1.io }), EXIT.usage);

    const uBare2 = makeIo();
    assert.equal(bizCommand({ command: 'list', positional: [], flags: { 'lain-home': '' }, io: uBare2.io }), EXIT.usage);

    const uCreateMissingArg = makeIo();
    assert.equal(bizCommand({ command: 'create', positional: [], flags: {}, io: uCreateMissingArg.io, dbPath }), EXIT.usage);

    const uCreateNoFile = makeIo();
    assert.equal(
      bizCommand({ command: 'create', positional: [join(dir, 'missing.json')], flags: {}, io: uCreateNoFile.io, dbPath }),
      EXIT.usage,
    );
    assert.match(uCreateNoFile.err.join('\n'), /cannot read opportunity file/);

    const badJsonPath = join(dir, 'bad.json');
    writeFileSync(badJsonPath, '{not-json', 'utf8');
    const uCreateBadJson = makeIo();
    assert.equal(bizCommand({ command: 'create', positional: [badJsonPath], flags: {}, io: uCreateBadJson.io, dbPath }), EXIT.usage);

    const arrayJsonPath = join(dir, 'array.json');
    writeFileSync(arrayJsonPath, '[]', 'utf8');
    const uCreateArr = makeIo();
    assert.equal(bizCommand({ command: 'create', positional: [arrayJsonPath], flags: {}, io: uCreateArr.io, dbPath }), EXIT.usage);

    const uVal = makeIo();
    assert.equal(bizCommand({ command: 'validate', positional: ['opp-1'], flags: { by: 'alice' }, io: uVal.io, dbPath }), EXIT.usage);

    const uApp1 = makeIo();
    assert.equal(bizCommand({ command: 'approve', positional: ['opp-1'], flags: { by: 'alice' }, io: uApp1.io, dbPath }), EXIT.usage);

    const uAppNeg = makeIo();
    assert.equal(
      bizCommand({ command: 'approve', positional: ['opp-1'], flags: { by: 'alice', 'max-spend': '-10' }, io: uAppNeg.io, dbPath }),
      EXIT.usage,
    );

    const uAppNan = makeIo();
    assert.equal(
      bizCommand({ command: 'approve', positional: ['opp-1'], flags: { by: 'alice', 'max-spend': 'Infinity' }, io: uAppNan.io, dbPath }),
      EXIT.usage,
    );

    const uShow = makeIo();
    assert.equal(bizCommand({ command: 'show', positional: [], flags: {}, io: uShow.io, dbPath }), EXIT.usage);

    const uList = makeIo();
    assert.equal(bizCommand({ command: 'list', positional: [], flags: { status: 'bogus' }, io: uList.io, dbPath }), EXIT.usage);

    // Unused oppPath sanity check: valid file still untouched
    assert.ok(existsSync(oppPath));
  });
});

test('bizCommand lifecycle: create -> fail-closed approve (3) -> validate -> approve -> show -> list', () => {
  withTempEnv(({ dir, dbPath, oppPath }) => {
    const createIo = makeIo();
    assert.equal(
      bizCommand({ command: 'create', positional: [oppPath], flags: { json: true }, io: createIo.io, dbPath }),
      EXIT.ok,
    );
    const created = JSON.parse(createIo.out.join('\n'));
    assert.equal(created.id, 'opp-p8-1');
    assert.equal(created.status, 'draft');

    // Duplicate id -> exit 3 (OPPORTUNITY_EXISTS)
    const dupIo = makeIo();
    assert.equal(
      bizCommand({ command: 'create', positional: [oppPath], flags: {}, io: dupIo.io, dbPath }),
      EXIT.refused,
    );
    assert.match(dupIo.err.join('\n'), /OPPORTUNITY_EXISTS/);

    // Invalid payload -> exit 4 (BizError)
    const badOppPath = join(dir, 'invalid-opp.json');
    writeFileSync(badOppPath, JSON.stringify(sampleOpportunity({ id: 'opp-bad', assumptions: [] })), 'utf8');
    const badCreateIo = makeIo();
    assert.equal(
      bizCommand({ command: 'create', positional: [badOppPath], flags: {}, io: badCreateIo.io, dbPath }),
      EXIT.failed,
    );

    // Fail-closed: approve before validate -> exit 3 (APPROVAL_REQUIRES_VALIDATION)
    const earlyApprove = makeIo();
    assert.equal(
      bizCommand({
        command: 'approve',
        positional: ['opp-p8-1'],
        flags: { by: 'finance-lead', 'max-spend': '500' },
        io: earlyApprove.io,
        dbPath,
      }),
      EXIT.refused,
    );
    assert.match(earlyApprove.err.join('\n'), /APPROVAL_REQUIRES_VALIDATION/);

    // Validate -> validated
    const valIo = makeIo();
    assert.equal(
      bizCommand({
        command: 'validate',
        positional: ['opp-p8-1'],
        flags: { evidence: '10/10 bookkeepers confirmed pain', by: 'pm-lead', json: true },
        io: valIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const validated = JSON.parse(valIo.out.join('\n'));
    assert.equal(validated.status, 'validated');
    assert.equal(validated.validated_by, 'pm-lead');

    // Approve -> approved
    const approveIo = makeIo();
    assert.equal(
      bizCommand({
        command: 'approve',
        positional: ['opp-p8-1'],
        flags: { by: 'finance-lead', 'max-spend': '500', json: true },
        io: approveIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const approved = JSON.parse(approveIo.out.join('\n'));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, 'finance-lead');
    assert.equal(approved.approved_spend_usd, 500);

    // Show (json and human)
    const showJson = makeIo();
    assert.equal(
      bizCommand({ command: 'show', positional: ['opp-p8-1'], flags: { json: true }, io: showJson.io, dbPath }),
      EXIT.ok,
    );
    assert.equal(JSON.parse(showJson.out.join('\n')).id, 'opp-p8-1');

    const showHuman = makeIo();
    assert.equal(bizCommand({ command: 'show', positional: ['opp-p8-1'], flags: {}, io: showHuman.io, dbPath }), EXIT.ok);
    assert.match(showHuman.out.join('\n'), /status\s+approved/);

    // Show missing -> exit 4
    const showMissing = makeIo();
    assert.equal(
      bizCommand({ command: 'show', positional: ['does-not-exist'], flags: {}, io: showMissing.io, dbPath }),
      EXIT.failed,
    );
    assert.match(showMissing.err.join('\n'), /OPPORTUNITY_NOT_FOUND/);

    // Second opportunity: validate --fail -> rejected, then approve -> exit 3 (OPPORTUNITY_REJECTED)
    const opp2Path = join(dir, 'opp2.json');
    writeFileSync(opp2Path, JSON.stringify(sampleOpportunity({ id: 'opp-p8-2', title: 'Rejected idea' })), 'utf8');
    const create2Io = makeIo();
    assert.equal(bizCommand({ command: 'create', positional: [opp2Path], flags: {}, io: create2Io.io, dbPath }), EXIT.ok);
    assert.match(create2Io.out.join('\n'), /created opp-p8-2 status=draft/);

    const failValIo = makeIo();
    assert.equal(
      bizCommand({
        command: 'validate',
        positional: ['opp-p8-2'],
        flags: { evidence: 'Zero willingness to pay', by: 'pm-lead', fail: true },
        io: failValIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    assert.match(failValIo.out.join('\n'), /rejected opp-p8-2/);

    const approveRejectedIo = makeIo();
    assert.equal(
      bizCommand({
        command: 'approve',
        positional: ['opp-p8-2'],
        flags: { by: 'finance-lead', 'max-spend': '100' },
        io: approveRejectedIo.io,
        dbPath,
      }),
      EXIT.refused,
    );
    assert.match(approveRejectedIo.err.join('\n'), /OPPORTUNITY_REJECTED/);

    // List all and filtered
    const listAll = makeIo();
    assert.equal(bizCommand({ command: 'list', positional: [], flags: { json: true }, io: listAll.io, dbPath }), EXIT.ok);
    assert.equal(JSON.parse(listAll.out.join('\n')).length, 2);

    const listApproved = makeIo();
    assert.equal(
      bizCommand({ command: 'list', positional: [], flags: { status: 'approved' }, io: listApproved.io, dbPath }),
      EXIT.ok,
    );
    assert.match(listApproved.out.join('\n'), /opp-p8-1\s+\[approved\]/);

    const listDraft = makeIo();
    assert.equal(
      bizCommand({ command: 'list', positional: [], flags: { status: 'draft' }, io: listDraft.io, dbPath }),
      EXIT.ok,
    );
    assert.match(listDraft.out.join('\n'), /no opportunities found/);
  });
});

test('bizCommand resolves default biz.db inside LAIN_HOME when dbPath is omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lain-biz-home-'));
  try {
    const listIo = makeIo();
    assert.equal(
      bizCommand({ command: 'list', positional: [], flags: {}, io: listIo.io, env: { LAIN_HOME: dir } }),
      EXIT.ok,
    );
    assert.ok(existsSync(join(dir, 'biz.db')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
