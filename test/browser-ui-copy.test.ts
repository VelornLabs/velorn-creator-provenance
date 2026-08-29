import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile("web/src/main.ts", "utf8");
const webIndex = await readFile("web/index.html", "utf8");

function sourceSection(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return mainSource.slice(startIndex, endIndex);
}

test("browser copy discloses that fragment payloads are readable and retained", () => {
  assert.match(mainSource, /Media bytes stay on this device/u);
  assert.match(
    mainSource,
    /contain opted-in public manifest, profile, and receipt fields/u,
  );
  assert.match(mainSource, /They are encoded, not encrypted/u);
  assert.match(
    mainSource,
    /browser history, synced history, clipboard tools, or extensions may retain them/u,
  );
});

test("home, issue, and verify routes all render the fragment disclosure", () => {
  const home = sourceSection("function renderHome", "function definitionRow");
  const issue = sourceSection("function renderIssue", "function renderVerify");
  const verify = sourceSection("function renderVerify", "function renderError");

  for (const [route, source] of Object.entries({ home, issue, verify })) {
    assert.match(source, /fragmentDisclosure\(\)/u, `${route} omits disclosure`);
  }
});

test("home route describes the full public request and receipt payloads", () => {
  const home = sourceSection("function renderHome", "function definitionRow");
  assert.match(home, /full canonical public request/u);
  assert.match(home, /full canonical public receipt/u);
  assert.doesNotMatch(
    home,
    /reveals the exact hashes and network that would become public/u,
  );
});

test("wallet readiness copy promises connection only, never signing or spending", () => {
  const walletPanel = sourceSection(
    "function walletReadinessPanel",
    "function offlineDemoNotice",
  );
  assert.match(walletPanel, /optional check/u);
  assert.match(walletPanel, /automatically detects/u);
  assert.match(walletPanel, /authorize a Devnet-compatible public account/u);
  assert.match(walletPanel, /does not transmit that address/u);
  assert.match(walletPanel, /call a Solana RPC/u);
  assert.match(walletPanel, /request a signature/u);
  assert.match(walletPanel, /prepare or send a transaction/u);
  assert.match(walletPanel, /spend anything/u);
  assert.match(walletPanel, /wallet extension follows its own privacy/u);
  assert.match(walletPanel, /Cancel local connection attempt/u);
  assert.match(walletPanel, /Clear local connection/u);
});

test("the home route mounts and disposes the optional wallet readiness check", () => {
  const home = sourceSection("function renderHome", "function definitionRow");
  assert.match(home, /walletReadinessPanel\(pageSignal\)/u);
  assert.match(mainSource, /pageSignal\.addEventListener\("abort", dispose/u);
  assert.match(
    mainSource,
    /actions\.replaceChildren\(\);\s+status\.replaceChildren\(\);/u,
  );
});

test("issue copy scopes wallet discovery claims to the issue route", () => {
  const issue = sourceSection("function renderIssue", "function renderVerify");
  assert.match(issue, /This issue page does not show the wallet readiness panel/u);
  assert.doesNotMatch(issue, /browser slice does not discover a wallet/u);
});

test("real receipt verification is explicit, fixed to Devnet, and keeps media local", () => {
  const liveCheck = sourceSection(
    "function liveChainCheck",
    "function formatBytes",
  );
  const verify = sourceSection("function renderVerify", "function renderError");

  assert.match(liveCheck, /Check live Solana Devnet/u);
  assert.match(liveCheck, /explicitly choose the live check/u);
  assert.match(liveCheck, /IP address/u);
  assert.match(liveCheck, /media bytes, filename, and local path are never sent/u);
  assert.match(liveCheck, /import\("\.\.\/\.\.\/src\/verify-chain\.js"\)/u);
  assert.match(liveCheck, /verifyShareableReceiptOnDevnet\(receipt/u);
  assert.match(liveCheck, /Cancel live check/u);
  assert.match(liveCheck, /has not been marked invalid/u);
  assert.match(liveCheck, /supporting references/u);
  assert.match(liveCheck, /does not yet decode each historical transaction/u);
  assert.match(liveCheck, /not an on-chain timestamp/u);
  assert.match(verify, /isOfflineDemoRequest\(payload\.request\)[\s\S]*syntheticChainCheckPanel\(\)[\s\S]*liveChainCheck\(payload, pageSignal\)/u);
});

test("only the public verifier CSP permits the fixed Devnet HTTP endpoint", () => {
  assert.match(
    webIndex,
    /connect-src 'self' https:\/\/api\.devnet\.solana\.com/u,
  );
  assert.doesNotMatch(webIndex, /wss:|https:\/\/\*/u);
});
