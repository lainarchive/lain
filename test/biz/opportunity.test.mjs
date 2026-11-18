import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPPORTUNITY_STATUSES,
  BizError,
  computeUnitEconomics,
  openOpportunityStore,
} from '../../src/biz/opportunity.mjs';

function makeValidDraft(overrides = {}) {
  return {
    title: 'Automated Invoice Reconciliation',
    category: 'saas-automation',
    hypothesis: 'SMBs will pay $49/mo to eliminate manual invoice matching.',
    assumptions: ['Average customer processes 200 invoices/month', 'API cost stays under $2/customer'],
    risks: ['ERP API rate limits', 'Low willingness to switch from spreadsheets'],
    validation_plan: ['Interview 10 bookkeepers', 'Run 2-week concierge pilot with 3 firms'],
    sources: ['Customer discovery notes 2026-10', 'QuickBooks API pricing sheet'],
    economics: {
      price_usd: 49,
      unit_cost_usd: 9,
      fixed_cost_usd: 1000,
      estimated_units: 50,
    },
    ...overrides,
  };
}

describe('Phase 8 — Business Intelligence & Opportunity Workflow Core', () => {
  it('AT-P8-01: computeUnitEconomics calculates metrics and rejects negative or non-finite inputs', () => {
    assert.deepEqual(OPPORTUNITY_STATUSES, ['draft', 'validated', 'approved', 'rejected']);

    const econ = computeUnitEconomics({
      price_usd: 49,
      unit_cost_usd: 9,
      fixed_cost_usd: 1000,
      estimated_units: 50,
    });
    assert.equal(econ.revenue_usd, 2450);
    assert.equal(econ.variable_cost_usd, 450);
    assert.equal(econ.gross_profit_usd, 2000);
    assert.equal(econ.net_profit_usd, 1000);
    assert.equal(econ.margin_pct, 40.82);
    assert.equal(econ.break_even_units, 25);

    const zeroRev = computeUnitEconomics({
      price_usd: 0,
      unit_cost_usd: 5,
      fixed_cost_usd: 100,
      estimated_units: 0,
    });
    assert.equal(zeroRev.revenue_usd, 0);
    assert.equal(zeroRev.net_profit_usd, -100);
    assert.equal(zeroRev.margin_pct, 0);
    assert.equal(zeroRev.break_even_units, null);

    const underwater = computeUnitEconomics({
      price_usd: 10,
      unit_cost_usd: 10,
      fixed_cost_usd: 500,
      estimated_units: 20,
    });
    assert.equal(underwater.break_even_units, null);

    for (const bad of [
      { price_usd: -1, unit_cost_usd: 1, fixed_cost_usd: 10, estimated_units: 5 },
      { price_usd: 10, unit_cost_usd: Number.NaN, fixed_cost_usd: 10, estimated_units: 5 },
      { price_usd: 10, unit_cost_usd: 1, fixed_cost_usd: Number.POSITIVE_INFINITY, estimated_units: 5 },
      { price_usd: 10, unit_cost_usd: 1, fixed_cost_usd: 10, estimated_units: -0.5 },
    ]) {
      assert.throws(
        () => computeUnitEconomics(bad),
        (err) => err instanceof BizError && err.code === 'INVALID_ECONOMICS',
      );
    }
  });

  it('AT-P8-02: createOpportunity rejects missing or empty assumptions, sources, risks, or validation_plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-biz-p8-02-'));
    const store = openOpportunityStore({ path: join(dir, 'opp.db') });
    try {
      for (const field of ['assumptions', 'risks', 'validation_plan', 'sources']) {
        assert.throws(
          () => store.createOpportunity(makeValidDraft({ [field]: [] })),
          (err) => err instanceof BizError && err.code === 'INVALID_OPPORTUNITY',
        );
        assert.throws(
          () => store.createOpportunity(makeValidDraft({ [field]: ['   '] })),
          (err) => err instanceof BizError && err.code === 'INVALID_OPPORTUNITY',
        );
      }

      for (const field of ['title', 'category', 'hypothesis']) {
        assert.throws(
          () => store.createOpportunity(makeValidDraft({ [field]: '' })),
          (err) => err instanceof BizError && err.code === 'INVALID_OPPORTUNITY',
        );
      }

      store.createOpportunity(makeValidDraft({ id: 'dup-id' }));
      assert.throws(
        () => store.createOpportunity(makeValidDraft({ id: 'dup-id' })),
        (err) => err instanceof BizError && err.code === 'OPPORTUNITY_EXISTS',
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P8-03: approveCommitment fails closed before validation and on invalid spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-biz-p8-03-'));
    const store = openOpportunityStore({ path: join(dir, 'opp.db') });
    try {
      const opp = store.createOpportunity(makeValidDraft({ id: 'opp-draft-1' }));
      assert.equal(opp.status, 'draft');
      assert.equal(opp.approved_spend_usd, 0);

      assert.throws(
        () => store.approveCommitment(opp.id, { approvedBy: 'operator', maxSpendUsd: 500 }),
        (err) => err instanceof BizError && err.code === 'APPROVAL_REQUIRES_VALIDATION',
      );

      assert.throws(
        () => store.approveCommitment('missing-id', { approvedBy: 'operator', maxSpendUsd: 500 }),
        (err) => err instanceof BizError && err.code === 'OPPORTUNITY_NOT_FOUND',
      );

      assert.throws(
        () => store.approveCommitment(opp.id, { approvedBy: 'operator', maxSpendUsd: -10 }),
        (err) => err instanceof BizError && err.code === 'INVALID_APPROVAL',
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P8-04: failed validation rejects opportunity and blocks approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-biz-p8-04-'));
    const store = openOpportunityStore({ path: join(dir, 'opp.db') });
    try {
      const opp = store.createOpportunity(makeValidDraft({ id: 'opp-rej-1' }));
      const rejected = store.recordValidation(opp.id, {
        evidence: '0 of 10 interviewed firms willing to pay $49/mo',
        passed: false,
        reviewer: 'analyst-1',
      });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.validated_by, 'analyst-1');
      assert.equal(rejected.validation_evidence, '0 of 10 interviewed firms willing to pay $49/mo');
      assert.ok(rejected.validated_at);

      assert.throws(
        () => store.approveCommitment(opp.id, { approvedBy: 'operator', maxSpendUsd: 100 }),
        (err) => err instanceof BizError && err.code === 'OPPORTUNITY_REJECTED',
      );

      assert.throws(
        () =>
          store.recordValidation(opp.id, {
            evidence: 'retry',
            passed: true,
            reviewer: 'analyst-1',
          }),
        (err) => err instanceof BizError && err.code === 'INVALID_STATE',
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P8-05: full draft -> validated -> approved lifecycle persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-biz-p8-05-'));
    const dbPath = join(dir, 'opp.db');
    let tick = 1_760_000_000_000;
    const now = () => {
      tick += 1000;
      return tick;
    };

    const store1 = openOpportunityStore({ path: dbPath, now });
    const created = store1.createOpportunity(makeValidDraft({ id: 'opp-life-1' }));
    assert.equal(created.status, 'draft');
    assert.equal(created.approved_spend_usd, 0);

    const validated = store1.recordValidation(created.id, {
      evidence: '3 of 3 pilot firms signed LOI at $49/mo',
      passed: true,
      reviewer: 'analyst-2',
    });
    assert.equal(validated.status, 'validated');

    const approved = store1.approveCommitment(created.id, {
      approvedBy: 'founder',
      maxSpendUsd: 750,
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, 'founder');
    assert.equal(approved.approved_spend_usd, 750);
    assert.ok(approved.approved_at);

    assert.throws(
      () => store1.approveCommitment(created.id, { approvedBy: 'founder', maxSpendUsd: 900 }),
      (err) => err instanceof BizError && err.code === 'INVALID_STATE',
    );
    store1.close();

    const store2 = openOpportunityStore({ path: dbPath, now });
    try {
      const reloaded = store2.get(created.id);
      assert.ok(reloaded);
      assert.equal(reloaded.status, 'approved');
      assert.equal(reloaded.approved_by, 'founder');
      assert.equal(reloaded.approved_spend_usd, 750);
      assert.deepEqual(reloaded.assumptions, makeValidDraft().assumptions);
      assert.equal(reloaded.economics.net_profit_usd, 1000);

      assert.equal(store2.list({ status: 'approved' }).length, 1);
      assert.equal(store2.list({ status: 'draft' }).length, 0);
      assert.equal(store2.list().length, 1);
    } finally {
      store2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P8-06: assertOpen() rejects all operations after close()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lain-biz-p8-06-'));
    const store = openOpportunityStore({ path: join(dir, 'opp.db') });
    try {
      const opp = store.createOpportunity(makeValidDraft({ id: 'opp-close-1' }));
      store.close();
      store.close(); // idempotent

      for (const fn of [
        () => store.createOpportunity(makeValidDraft()),
        () => store.recordValidation(opp.id, { evidence: 'e', passed: true, reviewer: 'r' }),
        () => store.approveCommitment(opp.id, { approvedBy: 'a', maxSpendUsd: 10 }),
        () => store.get(opp.id),
        () => store.list(),
      ]) {
        assert.throws(fn, (err) => err instanceof BizError && err.code === 'STORE_CLOSED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AT-P8-07: break_even_units avoids IEEE-754 float overshoot on decimal cents', () => {
    const econ = computeUnitEconomics({
      price_usd: 0.3,
      unit_cost_usd: 0.2,
      fixed_cost_usd: 0.3,
      estimated_units: 10,
    });
    assert.equal(econ.break_even_units, 3);
  });
});
