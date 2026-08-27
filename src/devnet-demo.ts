import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  airdropFactory,
  generateKeyPairSigner,
  lamports,
  type Signature,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  fetchAttestation,
  fetchSchema,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  serializeAttestationData,
} from "sas-lib";

import { createMediaCommitment } from "./commitment.js";
import { loadOptionalDevnetWallet } from "./devnet-wallet.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  devnetAccountUrl,
  devnetTransactionUrl,
  type PublicProvenanceReceipt,
} from "./receipt.js";
import { createSasClient, sendAndConfirmInstructions } from "./sas-client.js";
import { verifyPublicReceipt } from "./verify.js";
import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
} from "./protocol.js";

const RPC_URL = process.env.SAS_RPC_URL ?? "https://api.devnet.solana.com";
const WSS_URL = process.env.SAS_WSS_URL ?? "wss://api.devnet.solana.com";
const EXPIRY_DAYS = 365;
const AIRDROP_LAMPORTS = 100_000_000n;

function transactionEvidence(signature: Signature) {
  return {
    signature,
    explorerUrl: devnetTransactionUrl(signature),
  };
}

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const mediaPath = path.join(projectRoot, "fixtures", "sample-export.txt");
  const manifestPath = path.join(projectRoot, "fixtures", "sample-provenance-manifest.json");
  const [mediaBytes, manifestText] = await Promise.all([
    readFile(mediaPath),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest: unknown = JSON.parse(manifestText);
  const commitment = createMediaCommitment(mediaBytes, manifest);
  const client = createSasClient(RPC_URL, WSS_URL);

  const observedGenesisHash = await client.rpc.getGenesisHash().send();
  if (observedGenesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Refusing to write to a non-Devnet cluster: ${observedGenesisHash}`,
    );
  }

  console.log("Velorn Creator Provenance PoC — Solana Devnet");
  console.log("Only public hashes, addresses, and signatures will be printed or saved.\n");

  const devnetWalletPath = path.join(projectRoot, ".local", "devnet-payer.json");
  const creator =
    (await loadOptionalDevnetWallet(devnetWalletPath)) ??
    (await generateKeyPairSigner());
  const subject = await generateKeyPairSigner();
  const credentialName = `${CREDENTIAL_NAME_PREFIX}-${subject.address.slice(0, 8)}`;

  console.log(`   Creator address: ${creator.address}`);

  console.log("1. Funding a disposable Devnet payer...");
  const airdrop = airdropFactory({
    rpc: client.rpc,
    rpcSubscriptions: client.rpcSubscriptions,
  });
  const { value: startingBalance } = await client.rpc
    .getBalance(creator.address, { commitment: "confirmed" })
    .send();
  if (startingBalance < 20_000_000n) {
    const airdropSignature = await airdrop({
      commitment: "confirmed",
      lamports: lamports(AIRDROP_LAMPORTS),
      recipientAddress: creator.address,
    });
    console.log(`   Airdrop: ${devnetTransactionUrl(airdropSignature)}`);
  } else {
    console.log(`   Existing Devnet balance: ${startingBalance.toString()} lamports`);
  }

  console.log("2. Creating a SAS credential...");
  const [credentialAddress] = await deriveCredentialPda({
    authority: creator.address,
    name: credentialName,
  });
  const credentialSignature = await sendAndConfirmInstructions(client, creator, [
    getCreateCredentialInstruction({
      payer: creator,
      credential: credentialAddress,
      authority: creator,
      name: credentialName,
      signers: [creator.address],
    }),
  ]);
  console.log(`   Credential: ${devnetAccountUrl(credentialAddress)}`);

  console.log("3. Creating the media-commitment schema...");
  const [schemaAddress] = await deriveSchemaPda({
    credential: credentialAddress,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  const schemaSignature = await sendAndConfirmInstructions(client, creator, [
    getCreateSchemaInstruction({
      authority: creator,
      payer: creator,
      name: SCHEMA_NAME,
      credential: credentialAddress,
      description:
        "Commits media and provenance-manifest hashes; does not assert copyright ownership",
      fieldNames: [...SCHEMA_FIELD_NAMES],
      schema: schemaAddress,
      layout: SCHEMA_LAYOUT,
    }),
  ]);
  console.log(`   Schema: ${devnetAccountUrl(schemaAddress)}`);

  console.log("4. Issuing the hash attestation...");
  const [attestationAddress] = await deriveAttestationPda({
    credential: credentialAddress,
    schema: schemaAddress,
    nonce: subject.address,
  });
  const schema = await fetchSchema(client.rpc, schemaAddress, {
    commitment: "confirmed",
  });
  const expiryUnixSeconds = BigInt(
    Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 24 * 60 * 60,
  );
  const attestationSignature = await sendAndConfirmInstructions(client, creator, [
    await getCreateAttestationInstruction({
      payer: creator,
      authority: creator,
      credential: credentialAddress,
      schema: schemaAddress,
      attestation: attestationAddress,
      nonce: subject.address,
      expiry: expiryUnixSeconds,
      data: serializeAttestationData(schema.data, {
        media_sha256: commitment.mediaSha256,
        manifest_sha256: commitment.manifestSha256,
        statement_type: commitment.statementType,
        version: commitment.version,
      }),
    }),
  ]);
  console.log(`   Attestation: ${devnetAccountUrl(attestationAddress)}`);

  const receipt: PublicProvenanceReceipt = {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName,
    schemaName: SCHEMA_NAME,
    credentialAddress,
    schemaAddress,
    attestationAddress,
    credentialAuthority: creator.address,
    authorizedSigner: creator.address,
    subjectNonce: subject.address,
    commitment,
    expiryUnixSeconds: expiryUnixSeconds.toString(),
    accountExplorerUrls: {
      credential: devnetAccountUrl(credentialAddress),
      schema: devnetAccountUrl(schemaAddress),
      attestation: devnetAccountUrl(attestationAddress),
    },
    transactions: {
      createCredential: transactionEvidence(credentialSignature),
      createSchema: transactionEvidence(schemaSignature),
      createAttestation: transactionEvidence(attestationSignature),
    },
    receiptWrittenAt: new Date().toISOString(),
    implementation: {
      sasLib: "1.0.10",
      solanaKit: "5.5.1",
    },
  };

  console.log("5. Fetching and verifying the public Devnet evidence...");
  const verification = await verifyPublicReceipt(receipt, {
    rpcUrl: RPC_URL,
    websocketUrl: WSS_URL,
    mediaBytes,
    manifest,
  });
  if (!verification.valid) {
    throw new Error(`Verification failed: ${JSON.stringify(verification.checks)}`);
  }

  const fetchedAttestation = await fetchAttestation(client.rpc, attestationAddress, {
    commitment: "confirmed",
  });
  if (fetchedAttestation.data.expiry !== expiryUnixSeconds) {
    throw new Error("Fetched expiry did not match the submitted attestation");
  }

  const artifactsDirectory = path.join(projectRoot, "artifacts");
  const receiptPath = path.join(artifactsDirectory, "devnet-receipt.json");
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log("\nVerification passed:");
  for (const [name, passed] of Object.entries(verification.checks)) {
    console.log(`   ${passed ? "PASS" : "FAIL"} ${name}`);
  }
  console.log(`\nPublic receipt written to ${receiptPath}`);
  console.log("No private keys were printed or written to the public receipt.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDevnet proof failed: ${message}`);
  console.error(
    "If this is an airdrop/rate-limit error, keep the disposable-wallet rule and retry later.",
  );
  process.exitCode = 1;
});
