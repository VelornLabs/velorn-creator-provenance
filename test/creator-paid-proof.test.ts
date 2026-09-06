import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountRole,
  blockhash,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type AccountMeta,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  parseCreateAttestationInstruction,
  parseCreateCredentialInstruction,
  parseCreateSchemaInstruction,
} from "sas-lib";

import { sha256HexPortable } from "../src/canonical-contract-runtime.js";
import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  type ProvenanceRequestV1,
} from "../src/contracts.js";
import {
  CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT,
  CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT,
  SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES,
  createCreatorPaidProofPlan,
  decodeAndValidateCreatorPaidProofWire,
  decodeAndValidateSignedCreatorPaidProofWire,
  type CreatorPaidProofPlan,
} from "../src/creator-paid-proof.js";
import {
  LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
  LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT,
  hasExactPinnedLocalDevnetComputeBudget,
} from "../src/devnet-transaction-policy.js";
import {
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
} from "../src/protocol.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "../src/receipt.js";

const FIXTURE_BLOCKHASH = blockhash("11111111111111111111111111111111");
const OBSERVED_SLOT = 50_000n;
const OBSERVED_BLOCK_HEIGHT = 60_000n;
const LAST_VALID_BLOCK_HEIGHT = 60_150n;
const EXPIRY_UNIX_SECONDS = 2_000_000_000n;

function fixtureRequest(suffix = "primary"): ProvenanceRequestV1 {
  const mediaBytes = new TextEncoder().encode(`creator-paid-proof-${suffix}`);
  return createProvenanceRequest({
    requestId: `request_creator_paid_${suffix}`,
    mediaSha256: sha256HexPortable(mediaBytes),
    manifest: {
      contract: PROVENANCE_MANIFEST_CONTRACT,
      version: CONTRACT_VERSION,
      statement: CREATOR_RELATIONSHIP_STATEMENT,
      declaredAt: "2026-09-03T12:00:00.000Z",
      media: {
        byteLength: String(mediaBytes.byteLength),
        mimeType: "video/mp4",
      },
      lifecycle: {
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "issue",
      },
    },
  });
}

function planInput(creator: KeyPairSigner, request = fixtureRequest()) {
  return {
    request,
    creatorAddress: creator.address,
    expiryUnixSeconds: EXPIRY_UNIX_SECONDS,
    confirmedContext: {
      commitment: "confirmed" as const,
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: OBSERVED_SLOT,
      observedBlockHeight: OBSERVED_BLOCK_HEIGHT,
    },
    lifetimeConstraint: {
      blockhash: FIXTURE_BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    },
  };
}

function wireFromPlan(plan: CreatorPaidProofPlan): Uint8Array {
  const wire = Uint8Array.from(
    Buffer.from(plan.unsignedTransactionBase64, "base64"),
  );
  assert.equal(wire.byteLength, plan.wireByteLength);
  return wire;
}

function decodableInstruction(instruction: Instruction) {
  assert.ok(instruction.accounts);
  assert.ok(instruction.data);
  return instruction as Instruction &
    InstructionWithAccounts<readonly AccountMeta[]> &
    InstructionWithData<ReadonlyUint8Array>;
}

async function signedWire(
  plan: CreatorPaidProofPlan,
  creator: KeyPairSigner,
): Promise<Uint8Array> {
  const transaction = getTransactionDecoder().decode(wireFromPlan(plan));
  const signed = await partiallySignTransaction(
    [creator.keyPair],
    transaction,
  );
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

function withCreatorSignature(
  wire: Uint8Array,
  plan: CreatorPaidProofPlan,
  creatorSignature: SignatureBytes,
): Uint8Array {
  const transaction = getTransactionDecoder().decode(wire);
  const replaced = Object.freeze({
    ...transaction,
    signatures: Object.freeze({
      [plan.creatorAddress]: Uint8Array.from(creatorSignature) as SignatureBytes,
    }),
  }) as Transaction;
  return Uint8Array.from(getTransactionEncoder().encode(replaced));
}

test("derives one deterministic per-request credential, schema, nonce, and proof plan", async () => {
  const creator = await generateKeyPairSigner();
  const input = planInput(creator);
  const first = await createCreatorPaidProofPlan(input);
  const second = await createCreatorPaidProofPlan(input);
  assert.deepEqual(second, first);

  assert.equal(first.creatorAddress, creator.address);
  assert.equal(first.feePayer, creator.address);
  assert.equal(first.authority, creator.address);
  assert.equal(first.commitment.mediaSha256, input.request.commitment.mediaSha256);
  assert.equal(
    first.commitment.manifestSha256,
    input.request.commitment.manifestSha256,
  );
  assert.match(first.canonicalRequestSha256, /^[0-9a-f]{64}$/u);
  assert.match(first.creatorRequestBindingSha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.credentialName.length, 32);
  assert.match(first.credentialName, /^VELORN-[A-Z2-7]{25}$/u);
  assert.equal(first.accountDataSizes.total > 0, true);
  assert.equal(
    first.costInputs.accountDataBytes.total,
    first.accountDataSizes.total,
  );
  assert.equal(
    first.costInputs.computeUnitLimit,
    LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
  );

  const changedRequest = await createCreatorPaidProofPlan(
    planInput(creator, fixtureRequest("changed")),
  );
  assert.notEqual(changedRequest.credentialAddress, first.credentialAddress);
  assert.notEqual(changedRequest.schemaAddress, first.schemaAddress);
  assert.notEqual(changedRequest.subjectNonce, first.subjectNonce);
  assert.notEqual(changedRequest.attestationAddress, first.attestationAddress);

  const otherCreator = await generateKeyPairSigner();
  const changedCreator = await createCreatorPaidProofPlan(
    planInput(otherCreator, input.request),
  );
  assert.notEqual(changedCreator.credentialAddress, first.credentialAddress);
  assert.notEqual(changedCreator.subjectNonce, first.subjectNonce);
});

test("builds one atomic legacy message with pinned budget then exactly three SAS creates", async () => {
  const creator = await generateKeyPairSigner();
  const plan = await createCreatorPaidProofPlan(planInput(creator));
  const wire = wireFromPlan(plan);
  const transaction = getTransactionDecoder().decode(wire);
  assert.deepEqual(Object.keys(transaction.signatures), [creator.address]);
  assert.equal(transaction.signatures[creator.address], null);

  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  assert.equal(compiled.version, "legacy");
  assert.equal(
    compiled.header.numSignerAccounts,
    CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT,
  );
  assert.equal(compiled.header.numReadonlySignerAccounts, 0);
  assert.equal(compiled.staticAccounts[0], creator.address);
  assert.equal(compiled.lifetimeToken, FIXTURE_BLOCKHASH);

  const message = decompileTransactionMessage(compiled, {
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  });
  assert.equal(message.feePayer.address, creator.address);
  assert.equal(message.instructions.length, 5);
  assert.equal(
    hasExactPinnedLocalDevnetComputeBudget(
      message.instructions,
      LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
    ),
    true,
  );

  const sasInstructions = message.instructions.slice(
    LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT,
  );
  assert.equal(sasInstructions.length, CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT);
  assert.equal(
    sasInstructions.every(
      (instruction) => instruction.programAddress === SAS_PROGRAM_ID,
    ),
    true,
  );
  const credential = parseCreateCredentialInstruction(
    decodableInstruction(sasInstructions[0]!),
  );
  const schema = parseCreateSchemaInstruction(
    decodableInstruction(sasInstructions[1]!),
  );
  const attestation = parseCreateAttestationInstruction(
    decodableInstruction(sasInstructions[2]!),
  );
  assert.equal(credential.accounts.payer.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(credential.accounts.authority.role, AccountRole.WRITABLE_SIGNER);
  assert.deepEqual(credential.data.signers, [creator.address]);
  assert.equal(schema.accounts.payer.address, creator.address);
  assert.equal(schema.accounts.authority.address, creator.address);
  assert.equal(schema.data.name, SCHEMA_NAME);
  assert.equal(schema.data.description, SCHEMA_DESCRIPTION);
  assert.deepEqual(schema.data.layout, SCHEMA_LAYOUT);
  assert.deepEqual(schema.data.fieldNames, [...SCHEMA_FIELD_NAMES]);
  assert.equal(attestation.accounts.payer.address, creator.address);
  assert.equal(attestation.accounts.authority.address, creator.address);
  assert.equal(attestation.data.nonce, plan.subjectNonce);
  assert.equal(attestation.data.expiry, EXPIRY_UNIX_SECONDS);
});

test("rejects any message, request, plan, signature-state, or packet mutation", async () => {
  const creator = await generateKeyPairSigner();
  const plan = await createCreatorPaidProofPlan(planInput(creator));
  const wire = wireFromPlan(plan);

  const decoded = getTransactionDecoder().decode(wire);
  const changedMessageBytes = Uint8Array.from(decoded.messageBytes);
  changedMessageBytes[changedMessageBytes.length - 1] =
    (changedMessageBytes[changedMessageBytes.length - 1] ?? 0) ^ 1;
  const changedMessage = Object.freeze({
    ...decoded,
    messageBytes:
      changedMessageBytes as unknown as Transaction["messageBytes"],
  }) as Transaction;
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(
      Uint8Array.from(getTransactionEncoder().encode(changedMessage)),
      plan,
    ),
    /canonical|CreateAttestation|exact/u,
  );

  const changedPlan = {
    ...plan,
    credentialName: `${plan.credentialName}-changed`,
  } as CreatorPaidProofPlan;
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(wire, changedPlan),
    /plan differs/u,
  );

  const otherRequestPlan = await createCreatorPaidProofPlan(
    planInput(creator, fixtureRequest("other")),
  );
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(wire, otherRequestPlan),
    /exact canonical|instruction|canonical/u,
  );

  const signed = await signedWire(plan, creator);
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(signed, plan),
    /empty creator signature/u,
  );
  await assert.rejects(
    decodeAndValidateSignedCreatorPaidProofWire(wire, plan),
    /64-byte creator signature/u,
  );
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(
      new Uint8Array(SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES + 1),
      plan,
    ),
    /bounded legacy wire size/u,
  );

  const copyTrap = new Uint8Array(
    SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES + 1,
  );
  Object.defineProperty(copyTrap, Symbol.iterator, {
    value: () => {
      throw new Error("oversized input was copied before validation");
    },
  });
  await assert.rejects(
    decodeAndValidateCreatorPaidProofWire(copyTrap, plan),
    /bounded legacy wire size/u,
  );
});

test("cryptographically validates the sole creator signature and exposes one receipt signature", async () => {
  const creator = await generateKeyPairSigner();
  const alternate = await generateKeyPairSigner();
  const plan = await createCreatorPaidProofPlan(planInput(creator));
  const unsignedWire = wireFromPlan(plan);
  const exactSignedWire = await signedWire(plan, creator);
  const validated = await decodeAndValidateSignedCreatorPaidProofWire(
    exactSignedWire,
    plan,
  );
  assert.equal(validated.creatorAddress, creator.address);
  assert.equal(validated.credentialAddress, plan.credentialAddress);
  assert.equal(validated.schemaAddress, plan.schemaAddress);
  assert.equal(validated.attestationAddress, plan.attestationAddress);
  assert.equal(validated.messageSha256, plan.messageSha256);
  assert.equal(validated.wireByteLength, exactSignedWire.byteLength);
  assert.equal(
    validated.transactionSignature,
    getSignatureFromTransaction(
      getTransactionDecoder().decode(exactSignedWire),
    ),
  );
  assert.equal(
    validated.signedTransactionBase64,
    Buffer.from(exactSignedWire).toString("base64"),
  );

  const transaction = getTransactionDecoder().decode(unsignedWire);
  const wrongSignature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      alternate.keyPair.privateKey,
      transaction.messageBytes,
    ),
  ) as SignatureBytes;
  await assert.rejects(
    decodeAndValidateSignedCreatorPaidProofWire(
      withCreatorSignature(unsignedWire, plan, wrongSignature),
      plan,
    ),
    /creator signature is invalid/u,
  );

  const corrupted = Uint8Array.from(
    getTransactionDecoder().decode(exactSignedWire).signatures[
      creator.address
    ]!,
  );
  corrupted[0] = (corrupted[0] ?? 0) ^ 1;
  await assert.rejects(
    decodeAndValidateSignedCreatorPaidProofWire(
      withCreatorSignature(
        unsignedWire,
        plan,
        corrupted as SignatureBytes,
      ),
      plan,
    ),
    /creator signature is invalid/u,
  );
});

test("keeps both unsigned and signed atomic transactions under Solana's packet limit", async () => {
  const creator = await generateKeyPairSigner();
  const plan = await createCreatorPaidProofPlan(planInput(creator));
  const unsignedWire = wireFromPlan(plan);
  const signed = await signedWire(plan, creator);
  assert.equal(unsignedWire.byteLength <= SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES, true);
  assert.equal(signed.byteLength <= SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES, true);
  assert.equal(unsignedWire.byteLength, signed.byteLength);
  assert.equal(plan.wireByteLength, unsignedWire.byteLength);
});
