import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Exercise the real orchestrator with isolated wallet/RPC seams. No network,
// real wallet, or browser storage is available to this test.
class TestElement {
  children: TestElement[] = [];
  textContent = "";
  className = "";
  listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  append(...children: TestElement[]) { this.children.push(...children); }
  replaceChildren(...children: TestElement[]) { this.children = children; }
  setAttribute() {}
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  all(): TestElement[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

test("an expired unsigned quote refreshes and returns to review without signing or sending", async () => {
  const receipt = JSON.parse(await readFile(
    "evidence/eternal-creator-paid-proof-2026-09-06/public-receipt.json", "utf8",
  ));
  const sourceUrl = new URL("../web/src/public-issuer.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = new Map<string, unknown>();
  for (const match of compiled.matchAll(/require\("([^"]+)"\)/gu)) {
    const name = match[1]!;
    modules.set(name, await import(name.startsWith(".")
      ? new URL(name.replace(/\.js$/u, ".ts"), sourceUrl).href : name));
  }
  let height = 60_000n;
  let lastValid = 60_150n;
  let preparations = 0;
  let simulations = 0;
  let signatures = 0;
  let sends = 0;
  let saves = 0;
  let fee = 5_600n;
  const rpc = {
    assertGenesis: async () => {},
    getLatestBlockhash: async () => {
      preparations++;
      return { blockhash: "11111111111111111111111111111111", contextSlot: 50_000n, lastValidBlockHeight: lastValid };
    },
    getBlockHeight: async () => height,
    getMultipleAccounts: async () => ({ accounts: [null, null, null] }),
    getFeeForMessage: async () => ({ value: fee }),
    getMinimumBalanceForRentExemption: async () => 1_000_000n,
    getBalance: async () => ({ value: 1_000_000_000n }),
    simulateExactTransaction: async () => { simulations++; return { succeeded: true }; },
    sendExactSignedWireOnce: async () => { sends++; throw new Error("Unexpected send"); },
  };
  const snapshot = {
    status: "connected", wallet: { name: "Test wallet" },
    account: { address: receipt.chainReceipt.authorizedSigner },
  };
  modules.set("./devnet-issuer-rpc.js", { createDevnetIssuerRpc: () => rpc });
  modules.set("./devnet-issuer-recovery-adapter.js", {
    createDevnetIssuerRecoveryRecord: () => ({
      load: async () => null,
      save: async () => { saves++; throw new Error("Unexpected save"); },
    }),
  });
  modules.set("./wallet-standard.js", {
    DevnetWalletConnection: class {
      subscribe(listener: (value: unknown) => void) { listener(snapshot); return () => {}; }
      getSnapshot() { return snapshot; }
      dispose() {}
    },
  });
  modules.set("./devnet-wallet-signing.js", {
    signDevnetLegacyTransaction: async () => { signatures++; throw new Error("Test wallet cancelled"); },
  });
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports, require: (name: string) => { assert.ok(modules.has(name)); return modules.get(name); },
    document: { createElement: (tag: string) => new TestElement(tag) },
    HTMLElement: TestElement, AbortSignal, DOMException, Uint8Array, TextEncoder,
    atob, btoa, setTimeout, clearTimeout, window: { setTimeout, clearTimeout },
  });
  const host = new TestElement("div");
  const controller = new AbortController();
  exports.mountPublicCreatorPaidIssuer({ host, request: receipt.request, signal: controller.signal });
  const find = (text: string) => host.all().find(node => node.tag === "button" && node.textContent === text);
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(predicate(), host.all().map(node => node.textContent).join("\n"));
  };
  const click = (text: string) => { const node = find(text); assert.ok(node, text); node.listeners.get("click")!(); return node; };
  try {
    await waitFor(() => !!find("Prepare exact Devnet transaction"));
    click("Prepare exact Devnet transaction");
    await waitFor(() => !!find("Approve and submit to Devnet"));
    height = 60_145n;
    const staleApproval = click("Approve and submit to Devnet");
    await waitFor(() => !!find("Refresh transaction"));
    assert.equal(find("Approve and submit to Devnet"), undefined);
    staleApproval.listeners.get("click")!();
    assert.equal(signatures, 0);
    height = 60_200n;
    lastValid = 60_350n;
    fee = 6_000n;
    click("Refresh transaction");
    await waitFor(() => !!find("Approve and submit to Devnet"));
    assert.equal(find("Refresh transaction"), undefined);
    assert.equal(preparations, 2);
    assert.equal(simulations, 3);
    assert.ok(host.all().some(node => node.textContent === "0.003006 Devnet SOL"));
    assert.equal(signatures, 0, "refresh must return to review before signing");
    assert.equal(saves, 0);
    assert.equal(sends, 0);
    click("Approve and submit to Devnet");
    await waitFor(() => signatures === 1 && !!find("Approve and submit to Devnet"));
    assert.equal(saves, 0);
    assert.equal(sends, 0);
  } finally { controller.abort(); }
});
