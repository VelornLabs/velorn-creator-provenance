import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("web/src/local-devnet-main.ts", "utf8");
const clientSource = await readFile("web/src/local-devnet-client.ts", "utf8");
const bootstrapSource = await readFile(
  "web/src/local-devnet-bootstrap.ts",
  "utf8",
);
const styles = await readFile("web/src/local-devnet-styles.css", "utf8");

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the live checkpoint fails closed outside the exact loopback origin", () => {
  assert.match(
    source,
    /LOCAL_DEVNET_UI_ORIGIN = "http:\/\/127\.0\.0\.1:4173" as const/u,
  );
  const originGuard = section(
    "export function isExactLocalDevnetOrigin",
    "\n}\n\nexport function createLocalDevnetRequestId",
  );
  assert.match(originGuard, /return origin === LOCAL_DEVNET_UI_ORIGIN/u);
  const bootstrap = section(
    'if (typeof window !== "undefined"',
    "\n}",
  );
  assert.match(bootstrap, /isExactLocalDevnetOrigin\(window\.location\.origin\)/u);
  assert.match(bootstrap, /renderOriginFailure\(root\)/u);
});

test("the local browser client does not pull in the Node-only receipt module", () => {
  assert.match(
    clientSource,
    /DEVNET_GENESIS_HASH,[\s\S]*SAS_PROGRAM_ID,[\s\S]*from "\.\.\/\.\.\/src\/solana-constants\.js"/u,
  );
  assert.doesNotMatch(clientSource, /from "\.\.\/\.\.\/src\/receipt\.js"/u);
});

test("the local browser entry fails visibly before any wallet or chain action", () => {
  assert.match(bootstrapSource, /import\("\.\/local-devnet-main\.js"\)/u);
  assert.match(bootstrapSource, /could not load/u);
  assert.match(bootstrapSource, /No wallet request or Solana transaction was started/u);
  assert.doesNotMatch(
    bootstrapSource,
    /createWalletConnection|startSession|signTransaction|fetch\(/u,
  );
});

test("a file selection creates a new real request rather than the offline fixture", () => {
  const requestFactory = section(
    "export function createLocalDevnetRequestId",
    "\nexport function devnetAccountExplorerUrl",
  );
  assert.match(requestFactory, /entropy\.byteLength !== 12/u);
  assert.match(requestFactory, /`request_devnet_\$\{timestampMilliseconds\}_\$\{suffix\}`/u);
  assert.match(requestFactory, /createProvenanceRequest/u);
  assert.match(requestFactory, /mediaSha256: input\.mediaSha256/u);
  assert.match(requestFactory, /byteLength: String\(input\.byteLength\)/u);
  assert.match(requestFactory, /action: "issue"/u);
  assert.doesNotMatch(requestFactory, /profile:|offline_demo|filename/u);
  const hashing = section("  async #hashFile", "\n  #cancelHash");
  assert.match(hashing, /hashBlob\(file/u);
  assert.match(hashing, /createLocalDevnetTestRequest/u);
  assert.match(hashing, /file\.size/u);
  assert.doesNotMatch(hashing, /file\.name/u);
});

test("Explorer links are fixed to Solana Devnet", () => {
  assert.match(
    source,
    /`https:\/\/explorer\.solana\.com\/address\/\$\{encodeURIComponent\(value\)\}\?cluster=devnet`/u,
  );
  assert.match(
    source,
    /`https:\/\/explorer\.solana\.com\/tx\/\$\{encodeURIComponent\(value\)\}\?cluster=devnet`/u,
  );
});

test("mount is inert until the explicit Start action", () => {
  const constructor = section("  constructor(\n", "\n  dispose(): void");
  assert.match(constructor, /this\.#render\(\)/u);
  assert.doesNotMatch(
    constructor,
    /createClient|createWalletConnection|startSession|\.connect\(/u,
  );
  const start = section("  #start(): Promise<void>", "\n  #connectWallet");
  assert.match(start, /createClient\(\)/u);
  assert.match(start, /await client\.startSession\(\)/u);
  assert.match(start, /createWalletConnection\(\)/u);
  const idle = section("  #renderIdle(): HTMLElement", "\n  #renderWallet");
  assert.match(idle, /Start local Devnet test/u);
  assert.match(idle, /does not connect a wallet/u);
});

test("pending or unwanted wallet selection can always be cleared locally", () => {
  const clear = section(
    "  #clearLocalWalletSelection(): void",
    "\n  #bindCreator",
  );
  assert.match(clear, /connection\.disconnect\(\)\.catch\(\(\) => undefined\)/u);
  assert.match(clear, /this\.#walletConnectAttempt \+= 1/u);
  assert.match(clear, /this\.#busy = false/u);
  assert.match(clear, /may retain site authorization/u);
  assert.doesNotMatch(clear, /deauthoriz|disconnect(?:ed)? Phantom/u);
  const wallet = section("  #renderWallet(): HTMLElement", "\n  #renderEnrollmentChoice");
  assert.match(wallet, /Cancel local connection attempt/u);
  assert.match(wallet, /Clear local wallet selection/u);
  assert.match(wallet, /allowWhileBusy: true/u);
  const connect = section("  #connectWallet", "\n  #selectWalletAccount");
  assert.match(connect, /attempt !== this\.#walletConnectAttempt/u);
});

test("both signatures require exact returned-wire validation and explicit review", () => {
  const enrollment = section(
    "  #signEnrollment(): Promise<void>",
    "\n  #checkEnrollmentStatus",
  );
  assert.match(enrollment, /signDevnet|signTransaction/u);
  assert.match(enrollment, /createExactWalletReturnedWireValidator\(\)/u);
  assert.match(enrollment, /completeEnrollment\(signedBase64\)/u);
  assert.match(enrollment, /this\.#enrollmentPlan = undefined/u);
  assert.match(enrollment, /signed\.fill\(0\)/u);

  const attestation = section(
    "  #signAttestation(): Promise<void>",
    "\n  #checkAttestationStatus",
  );
  assert.match(
    attestation,
    /createExactWalletReturnedWireValidator\(plan\.messageSha256\)/u,
  );
  assert.match(attestation, /completeAttestation\(signedBase64\)/u);
  assert.match(attestation, /this\.#attestationPlan = undefined/u);
  assert.match(attestation, /signed\.fill\(0\)/u);

  assert.match(source, /Signature review 1 of 2/u);
  assert.match(source, /Signature review 2 of 2/u);
  assert.match(source, /Sign and create on Devnet/u);
  assert.match(source, /Sign this exact Devnet proof/u);
});

test("a prepared plan can reconnect only the originally bound creator", () => {
  const reconnect = section(
    "  #renderBoundWalletRecovery(): HTMLElement | undefined",
    "\n  #bindCreator",
  );
  assert.match(reconnect, /Reconnect the same creator account/u);
  assert.match(reconnect, /account\.address === creator/u);
  assert.match(reconnect, /this\.#connectWallet\(wallet\)/u);
  assert.match(reconnect, /this\.#selectWalletAccount\(exactAccount\.address\)/u);
  assert.match(reconnect, /will not rebuild or replace it/u);
  assert.doesNotMatch(reconnect, /bindCreator|planEnrollment|beginAttestation/u);

  const enrollmentReview = section(
    "  #renderEnrollmentReview(): HTMLElement",
    "\n  #renderReusedEnrollment",
  );
  const attestationReview = section(
    "  #renderAttestationReview(): HTMLElement",
    "\n  #renderAttestationRecovery",
  );
  assert.match(enrollmentReview, /renderBoundWalletRecovery/u);
  assert.match(attestationReview, /renderBoundWalletRecovery/u);
});

test("uncertain completions expose status checks only and never resubmit", () => {
  const enrollmentRecovery = section(
    "  #renderEnrollmentRecovery(): HTMLElement",
    "\n  #renderFilePicker",
  );
  assert.match(enrollmentRecovery, /Check enrollment status/u);
  assert.doesNotMatch(
    enrollmentRecovery,
    /signEnrollment|completeEnrollment|Sign and create/u,
  );
  const attestationRecovery = section(
    "  #renderAttestationRecovery(): HTMLElement",
    "\n  #renderConfirmed",
  );
  assert.match(attestationRecovery, /Check proof status/u);
  assert.doesNotMatch(
    attestationRecovery,
    /signAttestation|completeAttestation|Sign this exact/u,
  );
  assert.match(source, /will not sign or submit again/u);
  assert.match(source, /Nothing was re-signed or resubmitted/u);
});

test("copy states the privacy, payment, and claim boundaries", () => {
  for (const pattern of [
    /never uses Mainnet/u,
    /creates a token/u,
    /uploads media/u,
    /prove copyright/u,
    /Enrollment is creator-paid/u,
    /proof is sponsor-paid/u,
    /rent-exempt account deposit/u,
    /blockhash usually lasts only about 60–90 seconds/u,
    /filename and media bytes are never sent/u,
    /not proof of copyright, identity, originality, permission, or truth/u,
  ]) {
    assert.match(source, pattern);
  }
  assert.doesNotMatch(source, /fee and rent(?:[., ]|$)/u);
});

test("the isolated page never persists, logs, or renders signed transaction wires", () => {
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|console\.|window\.location\.(?:hash|search)|signAndSendTransaction|createSolanaRpc/u,
  );
  assert.doesNotMatch(
    source,
    /text(?:Content)?\s*=\s*signed|dataRow\([^\n]*signedBase64/u,
  );
  assert.match(source, /let signedBase64 = ""/u);
  assert.match(source, /signedBase64 = ""/u);
  assert.match(styles, /^@import "\.\/styles\.css";/u);
  assert.doesNotMatch(source, /from "\.\/main\.js"/u);
});
