import assert from "node:assert/strict";
import test from "node:test";

import {
  blockhash,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  serializeCanonicalProvenanceRequestJson,
} from "../src/contracts.js";
import { sha256HexPortable } from "../src/canonical-contract-runtime.js";
import {
  createCreatorPaidProofPlan,
  decodeAndValidateSignedCreatorPaidProofWire,
  type ValidatedSignedCreatorPaidProofWire,
} from "../src/creator-paid-proof.js";
import { createAtomicCreatorPaidReceipt } from "../src/creator-paid-receipt.js";
import { DEVNET_GENESIS_HASH } from "../src/solana-constants.js";

const request = createProvenanceRequest({
  requestId: "request_20260903_atomic_receipt",
  mediaSha256: "1".repeat(64),
  manifest: {
    contract: PROVENANCE_MANIFEST_CONTRACT,
    version: CONTRACT_VERSION,
    statement: CREATOR_RELATIONSHIP_STATEMENT,
    declaredAt: "2026-09-03T16:00:00.000Z",
    media: { byteLength: "1234", mimeType: "video/mp4" },
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "issue",
    },
  },
});

async function fixture() {
  const creator = await generateKeyPairSigner();
  const plan = await createCreatorPaidProofPlan({
    request,
    creatorAddress: creator.address,
    expiryUnixSeconds: 2_000_000_000n,
    confirmedContext: {
      commitment: "confirmed",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: 50_000n,
      observedBlockHeight: 60_000n,
    },
    lifetimeConstraint: {
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 60_150n,
    },
  });
  const unsigned = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(plan.unsignedTransactionBase64, "base64")),
  );
  const signed = await partiallySignTransaction([creator.keyPair], unsigned);
  const signedWire = Uint8Array.from(getTransactionEncoder().encode(signed));
  const validatedProof = await decodeAndValidateSignedCreatorPaidProofWire(
    signedWire,
    plan,
  );
  return {
    creator,
    plan,
    signedWire,
    validatedProof,
    input: {
      request,
      plan,
      validatedProof,
      receiptWrittenAt: "2026-09-03T16:01:00.000Z",
    },
  } as const;
}

test("assembles one canonical v1 receipt only from exact validated wire evidence", async () => {
  const { input, plan, validatedProof } = await fixture();
  const receipt = createAtomicCreatorPaidReceipt(input);
  assert.deepEqual(receipt.request, request);
  assert.equal(receipt.chainReceipt.credentialAuthority, plan.creatorAddress);
  assert.equal(receipt.chainReceipt.authorizedSigner, plan.creatorAddress);
  assert.equal(receipt.chainReceipt.schemaName, "MEDIA-COMMITMENT");
  assert.equal(receipt.chainReceipt.credentialName, plan.credentialName);
  assert.deepEqual(receipt.chainReceipt.commitment, request.commitment);
  assert.deepEqual(
    Object.values(receipt.chainReceipt.transactions).map(({ signature }) => signature),
    [
      validatedProof.transactionSignature,
      validatedProof.transactionSignature,
      validatedProof.transactionSignature,
    ],
  );
  assert.match(
    receipt.chainReceipt.transactions.createAttestation.explorerUrl,
    /cluster=devnet$/u,
  );
});

test("rejects structural evidence forgery, plan mutation, and noncanonical receipt time", async () => {
  const { input, plan, validatedProof } = await fixture();
  assert.throws(
    () =>
      createAtomicCreatorPaidReceipt({
        ...input,
        validatedProof: { ...validatedProof } as ValidatedSignedCreatorPaidProofWire,
      }),
    /exact wire validator/u,
  );
  assert.throws(
    () =>
      createAtomicCreatorPaidReceipt({
        ...input,
        plan: { ...plan, credentialName: `${plan.credentialName.slice(0, -1)}A` },
      }),
    /exact canonical issue request/u,
  );
  assert.throws(
    () =>
      createAtomicCreatorPaidReceipt({
        ...input,
        receiptWrittenAt: "2026-09-03T16:01:00Z",
      }),
    /canonical UTC/u,
  );
});

test("immutable validated binding prevents post-validation media rebinding", async () => {
  const { creator, plan, signedWire } = await fixture();
  const mutablePlan = {
    ...plan,
    commitment: { ...plan.commitment },
  } as unknown as typeof plan;
  const validatedProof = await decodeAndValidateSignedCreatorPaidProofWire(
    signedWire,
    mutablePlan,
  );
  const alteredRequest = createProvenanceRequest({
    requestId: "request_20260903_rebound_receipt",
    mediaSha256: "2".repeat(64),
    manifest: request.manifest,
  });
  const alteredJson = serializeCanonicalProvenanceRequestJson(alteredRequest);
  const mutable = mutablePlan as unknown as Record<string, unknown>;
  mutable.canonicalRequestJson = alteredJson;
  mutable.canonicalRequestSha256 = sha256HexPortable(alteredJson);
  mutable.requestId = alteredRequest.requestId;
  mutable.commitment = { ...alteredRequest.commitment };

  assert.throws(
    () =>
      createAtomicCreatorPaidReceipt({
        request: alteredRequest,
        plan: mutablePlan,
        validatedProof,
        receiptWrittenAt: "2026-09-03T16:01:00.000Z",
      }),
    /exact canonical issue request/u,
  );
  assert.equal(creator.address, plan.creatorAddress);
});

test("cannot publish an atomic issue receipt for a revoke request", async () => {
  const { input } = await fixture();
  const revokeRequest = createProvenanceRequest({
    requestId: "request_20260903_atomic_revoke",
    mediaSha256: "1".repeat(64),
    manifest: {
      ...request.manifest,
      lifecycle: {
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "revoke",
        targetAttestationAddress: input.plan.attestationAddress,
      },
    },
  });
  assert.throws(
    () => createAtomicCreatorPaidReceipt({ ...input, request: revokeRequest }),
    /exact canonical issue request/u,
  );
});
