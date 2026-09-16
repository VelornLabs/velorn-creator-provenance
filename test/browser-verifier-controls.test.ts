import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Exercise the actual DOM control functions with deferred hashing/RPC. No wallet,
// network, or real file access is used by these state-transition tests.
const source = await readFile("web/src/main.ts", "utf8");
function section(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
class Element {
  children: Element[] = [];
  textContent = ""; className = ""; type = ""; hidden = false; disabled = false;
  files: { item(index: number): unknown } | undefined;
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const hashes: ReturnType<typeof deferred<string>>[] = [];
  const verifications: ReturnType<typeof deferred<any>>[] = [];
  const functions = [
    section("function userErrorMessage", "function createElement"),
    section("function createElement", "function homeLink"),
    section("function liveChainCheck", "function pageHeading"),
    "exports.localFileCheck = localFileCheck; exports.liveChainCheck = liveChainCheck;",
  ].join("\n");
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(functions, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, AbortController, DOMException, Error, MAX_USER_ERROR_CHARACTERS: 240,
    document: { createElement: (tag: string) => new Element(tag) },
    chainCheckLabel: (name: string) => name,
    hashBlobSha256: () => { const next = deferred<string>(); hashes.push(next); return next.promise; },
    require: (name: string) => {
      assert.equal(name, "../../src/verify-chain.js");
      return { verifyShareableReceiptOnDevnet: () => {
        const next = deferred<any>(); verifications.push(next); return next.promise;
      } };
    },
  });
  const page = new AbortController();
  const matches: boolean[] = [];
  const file: Element = exports.localFileCheck("expected", page.signal, (match: boolean) => matches.push(match), true);
  const chain: Element = exports.liveChainCheck({}, page.signal);
  const input = file.all().find(el => el.type === "file")!;
  const fileResult = file.all().find(el => el.attributes.get("role") === "status")!;
  const chainResult = chain.all().find(el => el.attributes.get("role") === "status")!;
  const click = () => chain.all().find(el => el.textContent === "Check live Solana Devnet")!.listeners.get("click")!();
  const select = (hasFile = true) => {
    input.files = { item: () => hasFile ? { size: 100 } : null };
    input.listeners.get("change")!();
  };
  return { file, chain, hashes, verifications, matches, page, fileResult, chainResult, click, select };
}

test("verifier checks start neutral and inert; a local match never checks Devnet", async () => {
  const ui = setup();
  assert.equal(ui.hashes.length, 0);
  assert.equal(ui.verifications.length, 0);
  assert.equal(ui.fileResult.className, "hash-result neutral");
  assert.equal(ui.chainResult.className, "hash-result neutral");
  assert.match(ui.fileResult.textContent, /Not compared/);
  assert.match(ui.chainResult.textContent, /Not checked/);
  ui.select();
  assert.equal(ui.fileResult.className, "hash-result working");
  ui.hashes[0]!.resolve("expected"); await flush();
  assert.equal(ui.fileResult.className, "hash-result match");
  assert.equal(ui.chainResult.className, "hash-result neutral");
  assert.deepEqual(ui.matches, [false, true]);
});

test("Devnet success cannot assert a file match; retries clear success and handle invalid/unavailable/cancelled results", async () => {
  const ui = setup();
  for (const [status, expected] of [["valid", "match"], ["invalid", "mismatch"], ["unavailable", "neutral"], ["cancelled", "neutral"]]) {
    ui.click();
    assert.equal(ui.chainResult.className, "hash-result working");
    await flush();
    ui.verifications.at(-1)!.resolve({ status, checks: { binding: status === "valid" } });
    await flush();
    assert.equal(ui.chainResult.className, `hash-result ${expected}`);
    assert.equal(ui.fileResult.className, "hash-result neutral");
  }
  ui.click(); await flush(); ui.verifications.at(-1)!.reject(new Error("offline")); await flush();
  assert.equal(ui.chainResult.className, "hash-result neutral");
  assert.match(ui.chainResult.textContent, /could not be checked/);
});

test("a new or cleared file invalidates old success and stale hashing cannot restore it", async () => {
  const ui = setup();
  ui.select(); ui.hashes[0]!.resolve("expected"); await flush();
  ui.select();
  assert.equal(ui.fileResult.className, "hash-result working");
  ui.hashes[1]!.resolve("different"); await flush();
  assert.equal(ui.fileResult.className, "hash-result mismatch");
  ui.select(); ui.select(false);
  ui.hashes[2]!.resolve("expected"); await flush();
  assert.equal(ui.fileResult.className, "hash-result neutral");
  assert.match(ui.fileResult.textContent, /no file selected/);
  assert.equal(ui.matches.at(-1), false);
});

test("cancelled hashing stays neutral and page exit prevents new checks or stale success", async () => {
  const ui = setup();
  ui.select();
  ui.hashes[0]!.reject(new DOMException("Cancelled", "AbortError")); await flush();
  assert.equal(ui.fileResult.className, "hash-result neutral");
  ui.select(); ui.click(); await flush();
  ui.page.abort();
  ui.hashes[1]!.resolve("expected"); ui.verifications[0]!.resolve({ status: "valid", checks: {} }); await flush();
  assert.notEqual(ui.fileResult.className, "hash-result match");
  assert.notEqual(ui.chainResult.className, "hash-result match");
  ui.select(); ui.click(); await flush();
  assert.equal(ui.hashes.length, 2);
  assert.equal(ui.verifications.length, 1);
});

test("verifier leads with independent controls and collapses evidence without removing boundaries", () => {
  const verify = section("function renderVerify", "function renderError");
  assert.match(verify, /Check whether your file matches this receipt/);
  assert.match(verify, /Identity is not verified/);
  assert.match(verify, /No wallet or payment is needed/);
  assert.ok(verify.indexOf("content.append(checks") < verify.indexOf("creatorProfilePanel"));
  assert.match(verify, /createElement\("details", \{ className: "panel verifier-details" \}\)/);
  assert.doesNotMatch(verify, /\.open\s*=\s*true/);
  assert.match(verify, /Technical evidence/);
  assert.match(verify, /readable, not encrypted/);
  assert.match(verify, /Later replacement or revocation declarations are not automatically discovered/);
});
