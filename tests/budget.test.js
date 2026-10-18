import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetSummary, nextAllowance, settleEntry, toUnits } from '../src/budget.js';

test('allowances round down, charges round up and overages prevent further launches', () => {
  assert.equal(toUnits(0.1234567), 123456);
  assert.equal(toUnits(0.1234567, { charge: true }), 123457);
  const config = { maxSourceBudgetUsd: 0.1, maxTotalChargeUsd: 1, maxSourceRuns: 20 };
  const entry = { allowanceUnits: 100000 };
  settleEntry(entry, { id: 'charged', status: 'FAILED', usageTotalUsd: 0.1000001 });
  assert.equal(budgetSummary(config, [entry]).overBudget, true);
  assert.equal(budgetSummary(config, [entry]).remainingSourceBudgetUsd, 0);
  assert.equal(nextAllowance(config, [entry]).stopReason, 'budget_exhausted');
  assert.equal(nextAllowance({ ...config, maxTotalChargeUsd: 1e100 }, []).allowanceUnits, 100000);
});

test('provisional, null and invalid cost fields cannot release a reservation', () => {
  const config = { maxSourceBudgetUsd: 1, maxSourceRuns: 20 };
  for (const run of [{ status: 'RUNNING', usageTotalUsd: 0 }, { status: 'SUCCEEDED' }, { status: 'SUCCEEDED', usageTotalUsd: null }, { status: 'FAILED', usageTotalUsd: -1 }, { status: 'FAILED', usageTotalUsd: '0' }]) {
    const entry = { allowanceUnits: 250000 };
    settleEntry(entry, run);
    assert.equal(budgetSummary(config, [entry]).reservedUnknownChargeUsd, 0.25);
  }
  const entry = { allowanceUnits: 250000 };
  settleEntry(entry, { status: 'SUCCEEDED', usageTotalUsd: 0 });
  assert.equal(budgetSummary(config, [entry]).remainingSourceBudgetUsd, 1);
});
