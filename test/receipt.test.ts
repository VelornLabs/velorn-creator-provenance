import assert from "node:assert/strict";
import test from "node:test";

import { createMediaCommitment } from "../src/commitment.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  assertPublicReceipt,
  devnetAccountUrl,
  devnetTransactionUrl,
  type PublicProvenanceReceipt,
} from "../src/receipt.js";

function fixtureReceipt(): PublicProvenanceReceipt {
  const signature = "public-signature";
  return {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: "VELORN-PROV-FIXTURE",
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: "credential",
    schemaAddress: "schema",
    attestationAddress: "attestation",
    credentialAuthority: "authority",
    authorizedSigner: "signer",
    subjectNonce: "subject",
    commitment: createMediaCommitment(Buffer.from("fixture"), { fixture: true }),
    expiryUnixSeconds: "2000000000",
    accountExplorerUrls: {
      credential: devnetAccountUrl("credential"),
      schema: devnetAccountUrl("schema"),
      attestation: devnetAccountUrl("attestation"),
    },
    transactions: {
      createCredential: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
      createSchema: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
      createAttestation: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
    },
    receiptWrittenAt: "2026-08-27T00:00:00.000Z",
    implementation: { sasLib: "1.0.10", solanaKit: "5.5.1" },
  };
}

test("a complete public receipt passes structural validation", () => {
  assert.doesNotThrow(() => assertPublicReceipt(fixtureReceipt()));
});

test("a receipt for another program is rejected", () => {
  const receipt: Record<string, unknown> = {
    ...fixtureReceipt(),
    sasProgramId: "unexpected-program",
  };
  assert.throws(() => assertPublicReceipt(receipt), /unexpected SAS program/);
});

test("Explorer URLs explicitly select Devnet", () => {
  assert.match(devnetAccountUrl("address"), /cluster=devnet$/);
  assert.match(devnetTransactionUrl("signature"), /cluster=devnet$/);
});
