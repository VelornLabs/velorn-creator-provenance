import assert from "node:assert/strict";
import test from "node:test";

import type { SponsorUnsignedPlan } from "../src/sponsor-policy.js";
import {
  LOCAL_DEVNET_PLAN_CONTRACT,
  createLocalDevnetUnsignedPlan,
  parseLocalDevnetUnsignedPlan,
  serializeLocalDevnetUnsignedPlan,
} from "../src/local-devnet-contract.js";
import { DEVNET_GENESIS_HASH } from "../src/receipt.js";

const ADDRESS_ONE = "11111111111111111111111111111111";
const ADDRESS_TWO = "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const ADDRESS_THREE = "3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5";
const ADDRESS_FOUR = "7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb";
const ADDRESS_FIVE = "9JWH8mSgs97njH8hWGJ8uJU7L9YuwaDZBeW9PzwsAkwN";
const ADDRESS_SIX = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";

function fixturePlan(): SponsorUnsignedPlan {
  return {
    planVersion: 1,
    planId: "abcdefghijklmnopqrstuv",
    planBinding: "1".repeat(64),
    canonicalRequestJson: "{}",
    requestId: "request-000001",
    requestHash: "2".repeat(64),
    creatorAuthority: ADDRESS_SIX,
    sponsorPayer: ADDRESS_ONE,
    credentialAddress: ADDRESS_TWO,
    schemaAddress: ADDRESS_THREE,
    nonceAddress: ADDRESS_FIVE,
    attestationAddress: ADDRESS_FOUR,
    approvedDataHex: "00ff",
    expiry: 2_000_000_000n,
    expectedRentAccountSpace: 341,
    lifetimeConstraint: {
      blockhash: ADDRESS_ONE,
      lastValidBlockHeight: 1_000_100n,
    },
    unsignedTransactionBase64: "AQ==",
    messageSha256: "3".repeat(64),
    createdAtUnixSeconds: 1_900_000_000n,
    prepareContextId: "local-devnet.prepare:1000:111111111111",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    prepareObservedSlot: 1_000n,
    prepareObservedBlockHeight: 1_000_000n,
  } as SponsorUnsignedPlan;
}

test("public unsigned-plan transport contains only creator-reviewable fields", () => {
  const plan = createLocalDevnetUnsignedPlan(fixturePlan());
  assert.equal(plan.contract, LOCAL_DEVNET_PLAN_CONTRACT);
  const encoded = serializeLocalDevnetUnsignedPlan(plan);
  assert.deepEqual(parseLocalDevnetUnsignedPlan(encoded), plan);
  assert.doesNotMatch(encoded, /private|secret|finalTransaction|sponsorSignature/u);
});

test("public plan converts every bigint to a canonical decimal string", () => {
  const plan = createLocalDevnetUnsignedPlan(fixturePlan());
  assert.equal(plan.expiryUnixSeconds, "2000000000");
  assert.equal(plan.lifetime.lastValidBlockHeight, "1000100");
  assert.equal(plan.prepareObservedSlot, "1000");
  assert.doesNotThrow(() => JSON.stringify(plan));
});

test("noncanonical, extra, cross-cluster, stale, and oversized plans fail closed", () => {
  const canonical = serializeLocalDevnetUnsignedPlan(
    createLocalDevnetUnsignedPlan(fixturePlan()),
  );
  const parsed = JSON.parse(canonical) as Record<string, unknown>;
  for (const mutation of [
    { ...parsed, unexpected: true },
    { ...parsed, network: "solana:mainnet" },
    {
      ...parsed,
      lifetime: {
        ...(parsed.lifetime as object),
        lastValidBlockHeight: "999999",
      },
    },
    { ...parsed, unsignedTransactionBase64: "A".repeat(2_000) },
    { ...parsed, unsignedTransactionBase64: "AB==" },
  ]) {
    assert.throws(
      () => parseLocalDevnetUnsignedPlan(JSON.stringify(mutation)),
      /Local Devnet contract rejected/u,
    );
  }
  assert.throws(
    () => parseLocalDevnetUnsignedPlan(` ${canonical}`),
    /not canonical/u,
  );
});

test("transport validation rejects accessor objects without invoking them", () => {
  const plan = { ...createLocalDevnetUnsignedPlan(fixturePlan()) };
  let reads = 0;
  Object.defineProperty(plan as object, "planId", {
    enumerable: true,
    get: () => {
      reads += 1;
      return "abcdefghijklmnopqrstuv";
    },
  });
  assert.throws(
    () => serializeLocalDevnetUnsignedPlan(plan),
    /not canonical JSON data/u,
  );
  assert.equal(reads, 0);
});
