import assert from "node:assert/strict";
import test from "node:test";

import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

import {
  LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
  LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  createPinnedLocalDevnetComputeBudgetInstructions,
  hasExactPinnedLocalDevnetComputeBudget,
} from "../src/devnet-transaction-policy.js";

test("pins an explicit tiny priority fee so wallets preserve reviewed bytes", () => {
  const instructions = createPinnedLocalDevnetComputeBudgetInstructions(
    LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
  );
  assert.equal(instructions.length, 2);
  const limit = parseSetComputeUnitLimitInstruction(
    instructions[0]! as ReturnType<typeof getSetComputeUnitLimitInstruction>,
  );
  const price = parseSetComputeUnitPriceInstruction(
    instructions[1]! as ReturnType<typeof getSetComputeUnitPriceInstruction>,
  );
  assert.equal(
    limit.data.units,
    LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
  );
  assert.equal(
    price.data.microLamports,
    LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  );
  assert.equal(
    hasExactPinnedLocalDevnetComputeBudget(
      instructions,
      LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
    ),
    true,
  );
});

test("rejects missing, reordered, duplicated, or altered compute-budget policy", () => {
  const expected = createPinnedLocalDevnetComputeBudgetInstructions(
    LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  );
  const cases = [
    [],
    [expected[1]!, expected[0]!],
    [expected[0]!, expected[0]!],
    [
      getSetComputeUnitLimitInstruction({ units: 199_999 }),
      expected[1]!,
    ],
    [
      expected[0]!,
      getSetComputeUnitPriceInstruction({ microLamports: 999n }),
    ],
  ];
  for (const instructions of cases) {
    assert.equal(
      hasExactPinnedLocalDevnetComputeBudget(
        instructions,
        LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
      ),
      false,
    );
  }
  assert.throws(
    () => createPinnedLocalDevnetComputeBudgetInstructions(300_000),
    /unsupported local Devnet compute-unit limit/u,
  );
});
