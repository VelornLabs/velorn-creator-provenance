import { address, blockhash } from "@solana/kit";

import { canonicalizeContractJson } from "./canonical-contract-runtime.js";
import { DEVNET_GENESIS_HASH, SAS_PROGRAM_ID } from "./receipt.js";
import {
  SOLANA_TRANSACTION_WIRE_LIMIT_BYTES,
  type SponsorUnsignedPlan,
} from "./sponsor-policy.js";

export const LOCAL_DEVNET_PLAN_CONTRACT =
  "velorn.local-devnet.unsigned-plan" as const;
export const LOCAL_DEVNET_PLAN_VERSION = 1 as const;
export const MAX_LOCAL_DEVNET_PLAN_JSON_BYTES = 12_000;

const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/u;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DATA_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/u;
const POSITIVE_INTEGER_PATTERN = /^(?:[1-9]\d*)$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const MAX_TRANSACTION_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;

export interface LocalDevnetUnsignedPlanV1 {
  readonly contract: typeof LOCAL_DEVNET_PLAN_CONTRACT;
  readonly version: typeof LOCAL_DEVNET_PLAN_VERSION;
  readonly network: "solana:devnet";
  readonly genesisHash: typeof DEVNET_GENESIS_HASH;
  readonly sasProgramId: typeof SAS_PROGRAM_ID;
  readonly planId: string;
  readonly planBinding: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly creatorAuthority: string;
  readonly sponsorPayer: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly nonceAddress: string;
  readonly attestationAddress: string;
  readonly approvedDataHex: string;
  readonly expiryUnixSeconds: string;
  readonly expectedRentAccountSpace: number;
  readonly lifetime: {
    readonly blockhash: string;
    readonly lastValidBlockHeight: string;
  };
  readonly unsignedTransactionBase64: string;
  readonly messageSha256: string;
  readonly createdAtUnixSeconds: string;
  readonly prepareContextId: string;
  readonly prepareObservedSlot: string;
  readonly prepareObservedBlockHeight: string;
}

export class LocalDevnetContractError extends Error {
  constructor(message: string) {
    super(`Local Devnet contract rejected value: ${message}`);
    this.name = "LocalDevnetContractError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetContractError(message);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${label} contains unsupported or missing properties`);
  }
}

function assertAddress(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  try {
    if (address(value) !== value) fail(`${label} is not canonical`);
  } catch {
    fail(`${label} is not a canonical Solana address`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertIntegerString(
  value: unknown,
  label: string,
  maximum: bigint,
  allowZero: boolean,
): asserts value is string {
  const pattern = allowZero
    ? NON_NEGATIVE_INTEGER_PATTERN
    : POSITIVE_INTEGER_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} must be a canonical decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) fail(`${label} exceeds its integer range`);
}

function assertCanonicalBase64(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TRANSACTION_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail("unsigned transaction must be canonical bounded base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding === 2) {
    const finalDataValue = alphabet.indexOf(value[value.length - 3] ?? "");
    if (finalDataValue < 0 || (finalDataValue & 0x0f) !== 0) {
      fail("unsigned transaction base64 has non-canonical padding bits");
    }
  }
  if (padding === 1) {
    const finalDataValue = alphabet.indexOf(value[value.length - 2] ?? "");
    if (finalDataValue < 0 || (finalDataValue & 0x03) !== 0) {
      fail("unsigned transaction base64 has non-canonical padding bits");
    }
  }
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (
    decodedBytes <= 0 ||
    decodedBytes > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("unsigned transaction exceeds the Solana packet limit");
  }
}

export function assertLocalDevnetUnsignedPlan(
  value: unknown,
): asserts value is LocalDevnetUnsignedPlanV1 {
  assertExactKeys(
    value,
    [
      "contract",
      "version",
      "network",
      "genesisHash",
      "sasProgramId",
      "planId",
      "planBinding",
      "requestId",
      "requestHash",
      "creatorAuthority",
      "sponsorPayer",
      "credentialAddress",
      "schemaAddress",
      "nonceAddress",
      "attestationAddress",
      "approvedDataHex",
      "expiryUnixSeconds",
      "expectedRentAccountSpace",
      "lifetime",
      "unsignedTransactionBase64",
      "messageSha256",
      "createdAtUnixSeconds",
      "prepareContextId",
      "prepareObservedSlot",
      "prepareObservedBlockHeight",
    ],
    "unsigned plan",
  );
  if (
    value.contract !== LOCAL_DEVNET_PLAN_CONTRACT ||
    value.version !== LOCAL_DEVNET_PLAN_VERSION ||
    value.network !== "solana:devnet" ||
    value.genesisHash !== DEVNET_GENESIS_HASH ||
    value.sasProgramId !== SAS_PROGRAM_ID
  ) {
    fail("unsigned plan version, network, or program is unsupported");
  }
  if (typeof value.planId !== "string" || !PLAN_ID_PATTERN.test(value.planId)) {
    fail("planId is malformed");
  }
  if (
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    fail("requestId is malformed");
  }
  assertSha256(value.planBinding, "planBinding");
  assertSha256(value.requestHash, "requestHash");
  assertSha256(value.messageSha256, "messageSha256");
  for (const [label, candidate] of [
    ["creatorAuthority", value.creatorAuthority],
    ["sponsorPayer", value.sponsorPayer],
    ["credentialAddress", value.credentialAddress],
    ["schemaAddress", value.schemaAddress],
    ["nonceAddress", value.nonceAddress],
    ["attestationAddress", value.attestationAddress],
  ] as const) {
    assertAddress(candidate, label);
  }
  if (value.creatorAuthority === value.sponsorPayer) {
    fail("creator and sponsor addresses must be distinct");
  }
  if (
    typeof value.approvedDataHex !== "string" ||
    value.approvedDataHex.length > 1_024 ||
    !DATA_HEX_PATTERN.test(value.approvedDataHex)
  ) {
    fail("approvedDataHex is not bounded canonical lowercase hex");
  }
  assertIntegerString(value.expiryUnixSeconds, "expiryUnixSeconds", MAX_I64, false);
  assertIntegerString(value.createdAtUnixSeconds, "createdAtUnixSeconds", MAX_I64, false);
  assertIntegerString(value.prepareObservedSlot, "prepareObservedSlot", MAX_U64, true);
  assertIntegerString(
    value.prepareObservedBlockHeight,
    "prepareObservedBlockHeight",
    MAX_U64,
    true,
  );
  if (
    typeof value.expectedRentAccountSpace !== "number" ||
    !Number.isSafeInteger(value.expectedRentAccountSpace) ||
    value.expectedRentAccountSpace <= 0
  ) {
    fail("expectedRentAccountSpace must be a positive safe integer");
  }
  assertExactKeys(value.lifetime, ["blockhash", "lastValidBlockHeight"], "lifetime");
  if (typeof value.lifetime.blockhash !== "string") {
    fail("lifetime blockhash must be a string");
  }
  try {
    if (blockhash(value.lifetime.blockhash) !== value.lifetime.blockhash) {
      fail("lifetime blockhash is not canonical");
    }
  } catch {
    fail("lifetime blockhash is not canonical base58");
  }
  assertIntegerString(
    value.lifetime.lastValidBlockHeight,
    "lastValidBlockHeight",
    MAX_U64,
    false,
  );
  if (
    BigInt(value.lifetime.lastValidBlockHeight) <=
    BigInt(value.prepareObservedBlockHeight)
  ) {
    fail("unsigned plan blockhash is already stale");
  }
  if (
    typeof value.prepareContextId !== "string" ||
    !CONTEXT_ID_PATTERN.test(value.prepareContextId)
  ) {
    fail("prepareContextId is malformed");
  }
  assertCanonicalBase64(value.unsignedTransactionBase64);
}

export function createLocalDevnetUnsignedPlan(
  plan: SponsorUnsignedPlan,
): LocalDevnetUnsignedPlanV1 {
  if (
    plan.planVersion !== LOCAL_DEVNET_PLAN_VERSION ||
    plan.observedGenesisHash !== DEVNET_GENESIS_HASH
  ) {
    fail("server plan version or network is unsupported");
  }
  const output: LocalDevnetUnsignedPlanV1 = {
    contract: LOCAL_DEVNET_PLAN_CONTRACT,
    version: LOCAL_DEVNET_PLAN_VERSION,
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    planId: plan.planId,
    planBinding: plan.planBinding,
    requestId: plan.requestId,
    requestHash: plan.requestHash,
    creatorAuthority: plan.creatorAuthority,
    sponsorPayer: plan.sponsorPayer,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    nonceAddress: plan.nonceAddress,
    attestationAddress: plan.attestationAddress,
    approvedDataHex: plan.approvedDataHex,
    expiryUnixSeconds: plan.expiry.toString(),
    expectedRentAccountSpace: plan.expectedRentAccountSpace,
    lifetime: {
      blockhash: plan.lifetimeConstraint.blockhash,
      lastValidBlockHeight:
        plan.lifetimeConstraint.lastValidBlockHeight.toString(),
    },
    unsignedTransactionBase64: plan.unsignedTransactionBase64,
    messageSha256: plan.messageSha256,
    createdAtUnixSeconds: plan.createdAtUnixSeconds.toString(),
    prepareContextId: plan.prepareContextId,
    prepareObservedSlot: plan.prepareObservedSlot.toString(),
    prepareObservedBlockHeight: plan.prepareObservedBlockHeight.toString(),
  };
  assertLocalDevnetUnsignedPlan(output);
  return Object.freeze({ ...output, lifetime: Object.freeze({ ...output.lifetime }) });
}

export function serializeLocalDevnetUnsignedPlan(
  value: LocalDevnetUnsignedPlanV1,
): string {
  let canonical: string;
  try {
    canonical = canonicalizeContractJson(value);
  } catch {
    fail("unsigned plan is not canonical JSON data");
  }
  const parsed: unknown = JSON.parse(canonical);
  assertLocalDevnetUnsignedPlan(parsed);
  if (new TextEncoder().encode(canonical).byteLength > MAX_LOCAL_DEVNET_PLAN_JSON_BYTES) {
    fail("unsigned plan JSON exceeds the local response cap");
  }
  return canonical;
}

export function parseLocalDevnetUnsignedPlan(
  canonicalJson: string,
): LocalDevnetUnsignedPlanV1 {
  if (typeof canonicalJson !== "string") fail("unsigned plan JSON must be a string");
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;
  if (bytes === 0 || bytes > MAX_LOCAL_DEVNET_PLAN_JSON_BYTES) {
    fail("unsigned plan JSON exceeds the local response cap");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch {
    fail("unsigned plan JSON could not be parsed");
  }
  assertLocalDevnetUnsignedPlan(parsed);
  if (serializeLocalDevnetUnsignedPlan(parsed) !== canonicalJson) {
    fail("unsigned plan JSON is not canonical");
  }
  return parsed;
}
