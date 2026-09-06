import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("web/src/public-issuer.ts", "utf8");
const recoverySource = await readFile(
  "web/src/devnet-issuer-recovery.ts",
  "utf8",
);
const receiptSource = await readFile("src/creator-paid-receipt.ts", "utf8");

function sourceSection(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("mounting the unlocked issuer performs no RPC, connection, signing, or send", () => {
  const setup = sourceSection(
    "export function mountPublicCreatorPaidIssuer",
    "const renderWallet",
  );
  assert.match(setup, /createDevnetIssuerRpc\(\)/u);
  assert.match(setup, /createDevnetIssuerRecoveryRecord\(\)/u);
  assert.doesNotMatch(
    setup,
    /\.assertGenesis\(|\.getLatestBlockhash\(|\.connect\(|signDevnetLegacyTransaction\(|\.sendExactSignedWireOnce\(/u,
  );
});

test("the public flow separates connect, preparation, review, signing, and sending", () => {
  assert.match(source, /button\(`Connect \$\{wallet\.name\}`/u);
  assert.match(source, /Prepare exact Devnet transaction/u);
  assert.match(source, /Review the exact public accounts and maximum quoted cost/u);
  assert.match(source, /Approve and submit to Devnet/u);
  assert.match(source, /Wallet prompts remaining", "One"/u);
  assert.match(source, /Media SHA-256/u);
  assert.match(source, /Manifest SHA-256/u);
  assert.match(source, /Proof expiry/u);
  assert.match(source, /creator-paid with valueless Devnet SOL/iu);
  assert.match(source, /does not upload the media or establish copyright/u);
});

test("wallet output is exactly revalidated before the one send boundary", () => {
  const signing = sourceSection("const signAndSubmit", "const dispose");
  const firstValidation = signing.indexOf(
    "decodeAndValidateSignedCreatorPaidProofWire",
  );
  const save = signing.indexOf("recoveryStore.save");
  const send = signing.indexOf("rpc.sendExactSignedWireOnce");
  assert.ok(firstValidation >= 0);
  assert.ok(save > firstValidation, "recovery must follow exact validation");
  assert.ok(send > save, "status recovery must be saved before sending");
  assert.doesNotMatch(signing, /signAndSendTransaction|sendTransaction/u);
  assert.equal(
    signing.match(/rpc\.sendExactSignedWireOnce/g)?.length,
    1,
    "the orchestrator must contain exactly one send boundary",
  );
});

test("recovery is public, bounded, status-only, and never retains transaction wire", () => {
  const persistedKeys = recoverySource.slice(
    recoverySource.indexOf("const SAVE_INPUT_KEYS"),
    recoverySource.indexOf("const RECORD_KEYS"),
  );
  assert.match(recoverySource, /MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES = 2_048/u);
  assert.match(recoverySource, /MAX_DEVNET_ISSUER_RECOVERY_RECORDS = 8/u);
  assert.match(recoverySource, /MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES/u);
  assert.match(recoverySource, /Web Locks coordination/u);
  assert.match(recoverySource, /compare-and-clear/iu);
  assert.match(recoverySource, /subjectNonce/u);
  assert.doesNotMatch(
    persistedKeys,
    /signedTransactionBase64|unsignedTransactionBase64|mediaBytes|filename|localPath/u,
  );
  assert.doesNotMatch(recoverySource, /fetch\(|sendTransaction|signTransaction/u);
  assert.match(source, /Status checks only · never resubmit/u);
  assert.match(source, /will never broadcast it again/u);
  assert.doesNotMatch(recoverySource, /24\s*\*\s*60\s*\*\s*60|AGE_MILLISECONDS/u);
});

test("browser receipt assembly requires finalized transaction wire evidence", () => {
  const finalize = sourceSection("const finalizeRecovery", "const checkRecovery");
  const fetchWire = finalize.indexOf("rpc.getFinalizedTransaction");
  const validateWire = finalize.indexOf(
    "decodeAndValidateSignedCreatorPaidProofWire",
  );
  const assembleReceipt = finalize.indexOf("createAtomicCreatorPaidReceipt");
  assert.ok(fetchWire >= 0);
  assert.ok(validateWire > fetchWire);
  assert.ok(assembleReceipt > validateWire);
  assert.match(finalize, /signedWireSha256/u);
  assert.doesNotMatch(finalize, /recoveryStore\.clear/u);
  assert.match(source, /recovery = record/u);
  assert.match(
    receiptSource,
    /createCredential: transaction,[\s\S]*createSchema: transaction,[\s\S]*createAttestation: transaction/u,
  );
  assert.match(receiptSource, /DEVNET_GENESIS_HASH/u);
  assert.match(receiptSource, /SAS_PROGRAM_ID/u);
  assert.doesNotMatch(receiptSource, /\bBuffer\b|from ["']node:|require\s*\(/u);
});

test("only anchored finalized blockhash expiry plus account absence permits retry clearing", () => {
  const recovery = sourceSection("const checkRecovery", "const startRecoveryCheck");
  const pending = recovery.indexOf(
    'finalObservation.confirmationStatus !== "finalized"',
  );
  const expiryRead = recovery.indexOf("rpc.isBlockhashValid");
  const expiry = recovery.indexOf("!blockhashValidity.value");
  const absent = recovery.indexOf(
    "accountRead.accounts.every((accountValue) => accountValue === null)",
  );
  const canClear = recovery.indexOf("recoveryCanClear = true", absent);
  assert.ok(pending >= 0 && expiryRead > pending);
  assert.ok(expiry > expiryRead && absent > expiry && canClear > absent);
  assert.match(
    recovery,
    /commitment: "finalized",\s*minContextSlot: blockhashValidity\.contextSlot/u,
  );
});

test("same-binding ownership and wallet invalidation fail closed without a dead UI", () => {
  const signing = sourceSection("const signAndSubmit", "const dispose");
  assert.match(signing, /if \(!savedResult\.inserted\)/u);
  assert.match(signing, /only check its status and will not send it again/u);
  assert.match(signing, /busy = false;\s*renderWallet\(\);/u);
  assert.match(source, /await recoveryStore\.load/u);
});
