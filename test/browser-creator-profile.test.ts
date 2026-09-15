import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createShareableProvenanceReceipt, serializeCanonicalProvenanceRequestJson } from "../src/contracts.js";
import { profileFromDraft, requestWithProfile } from "../web/src/creator-profile.js";
import { encodeIssueFragment, encodeVerifyFragment, parseAppFragment } from "../web/src/fragment-contract.js";
import { createOfflineDemoFragments } from "../web/src/demo-fixtures.js";

const receipt = JSON.parse(await readFile("evidence/eternal-creator-paid-proof-2026-09-06/public-receipt.json", "utf8"));
const empty = { enabled: false, displayName: "", portfolioUrl: "", hireUrl: "" };
const draft = { enabled: true, displayName: "  Test Creator  ", portfolioUrl: "https://example.com/work", hireUrl: "https://example.com/contact" };

test("no opt-in preserves the original request and ignores all draft fields", () => {
  assert.equal(profileFromDraft({ ...draft, enabled: false }), undefined);
  assert.equal(requestWithProfile(receipt.request, { ...draft, enabled: false }, "new_request_123"), receipt.request);
  assert.equal(encodeIssueFragment(requestWithProfile(receipt.request, empty, "new_request_123")), encodeIssueFragment(receipt.request));
});

test("profile creates a fresh, hash-bound request without mutating media, lifecycle, or the old receipt", () => {
  const before = JSON.stringify(receipt);
  const updated = requestWithProfile(receipt.request, draft, "new_request_123");
  assert.equal(updated.manifest.profile?.displayName, "Test Creator");
  assert.equal(updated.requestId, "new_request_123");
  assert.notEqual(updated.commitment.manifestSha256, receipt.request.commitment.manifestSha256);
  assert.deepEqual(updated.media, receipt.request.media);
  assert.deepEqual(updated.manifest.media, receipt.request.manifest.media);
  assert.deepEqual(updated.manifest.lifecycle, receipt.request.manifest.lifecycle);
  assert.equal(JSON.stringify(receipt), before);
  const parsed = parseAppFragment(encodeIssueFragment(updated));
  assert.equal(parsed.route, "issue");
  if (parsed.route === "issue") assert.deepEqual(parsed.payload, updated);
  assert.throws(() => createShareableProvenanceReceipt(updated, receipt.chainReceipt));
  const tampered = structuredClone(receipt.request);
  tampered.manifest.profile = updated.manifest.profile;
  assert.throws(() => serializeCanonicalProvenanceRequestJson(tampered));
  assert.throws(() => requestWithProfile(receipt.request, draft, receipt.request.requestId), /new request ID/);
});

test("new profile survives receipt serialization; changing any profile value invalidates the old binding", () => {
  const updated = requestWithProfile(receipt.request, draft, "new_request_123");
  // Structural fixture only: never evidence of a newly issued on-chain proof.
  const fixture = createShareableProvenanceReceipt(updated, { ...receipt.chainReceipt, commitment: updated.commitment });
  const decoded = parseAppFragment(encodeVerifyFragment(fixture));
  assert.equal(decoded.route, "verify");
  if (decoded.route === "verify") assert.deepEqual(decoded.payload.request.manifest.profile, updated.manifest.profile);
  for (const key of ["displayName", "portfolioUrl", "hireUrl"] as const) {
    const tampered = structuredClone(fixture);
    tampered.request.manifest.profile![key] += "changed";
    assert.throws(() => encodeVerifyFragment(tampered));
  }
  const removed = requestWithProfile(updated, empty, "removed_request");
  assert.equal(removed.manifest.profile, undefined);
  assert.notEqual(removed.commitment.manifestSha256, updated.commitment.manifestSha256);
  assert.equal(requestWithProfile(updated, draft, "unchanged_request"), updated);
});

test("invalid profile inputs fail closed and synthetic fixtures cannot become issuable edits", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "http://example.com", "https://user:password@example.com", "https://example.com/\nsecret"]) {
    assert.throws(() => profileFromDraft({ ...draft, portfolioUrl: value }), /https:\/\//);
    assert.throws(() => profileFromDraft({ ...draft, hireUrl: value }), /https:\/\//);
  }
  for (const name of ["", "  ", "a".repeat(81), "a\u0000b"]) assert.throws(() => profileFromDraft({ ...draft, displayName: name }));
  assert.equal(profileFromDraft({ ...draft, displayName: "Cafe\u0301" })?.displayName, "Café");
  assert.throws(() => profileFromDraft({ ...draft, portfolioUrl: `https://example.com/${"a".repeat(1500)}` }), /shorten/);
  const sample = parseAppFragment(createOfflineDemoFragments().issue);
  assert.equal(sample.route, "issue");
  if (sample.route === "issue") assert.throws(() => requestWithProfile(sample.payload, draft, "changed_sample"), /real issue/);
});

class Element {
  children: Element[] = [];
  textContent = ""; value = ""; type = ""; checked = false; disabled = false; hidden = false; open = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, (event?: any) => void>();
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  get childElementCount() { return this.children.length; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(type: string, fn: (event?: any) => void) { this.listeners.set(type, fn); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

async function loadUiModule(path: string, overrides = new Map<string, unknown>()) {
  const url = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(await readFile(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = new Map(overrides);
  for (const match of compiled.matchAll(/require\("([^"]+)"\)/gu)) {
    const name = match[1]!;
    if (!modules.has(name)) modules.set(name, await import(new URL(name.replace(/\.js$/u, ".ts"), url).href));
  }
  const exports: Record<string, any> = {};
  runInNewContext(compiled, { exports, require: (name: string) => modules.get(name), document: { createElement: (tag: string) => new Element(tag) }, TextEncoder, URL, crypto, structuredClone });
  return exports;
}

test("profile renderer uses text nodes and safe, clearly external links", async () => {
  const ui = await loadUiModule("../web/src/creator-profile-panel.ts");
  const panel: Element = ui.creatorProfilePanel(profileFromDraft({ ...draft, displayName: '<img src=x onerror="alert(1)">' }), true);
  assert.ok(panel.all().some(el => el.textContent === '<img src=x onerror="alert(1)">'));
  assert.equal(panel.all().some(el => el.tag === "img"), false);
  const links = panel.all().filter(el => el.tag === "a") as any[];
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.equal(link.referrerPolicy, "no-referrer");
  }
  assert.ok(panel.all().some(el => el.textContent.includes("not verified identity")));
  assert.throws(() => ui.creatorProfilePanel({ ...profileFromDraft(draft), hireUrl: "javascript:alert(1)" }));
});

test("editor requires opt-in and a new review, cancels cleanly, and ignores submits after page exit", async () => {
  const profileUi = await loadUiModule("../web/src/creator-profile-panel.ts");
  const ui = await loadUiModule("../web/src/creator-profile-editor.ts", new Map([["./creator-profile-panel.js", profileUi]]));
  const signal = new AbortController();
  const reviews: string[] = [];
  const editing: boolean[] = [];
  const panel: Element = ui.creatorProfileEditor(receipt.request, signal.signal, (value: boolean) => editing.push(value), (value: string) => reviews.push(value));
  const form = panel.all().find(el => el.tag === "form")!;
  const inputs = panel.all().filter(el => el.tag === "input");
  const submit = panel.all().find(el => el.type === "submit")!;
  assert.equal(inputs[0]!.checked, false);
  assert.equal(submit.disabled, true);
  panel.open = true; panel.listeners.get("toggle")!();
  assert.deepEqual(editing, [true]);
  inputs[0]!.checked = true;
  inputs[1]!.value = "Test Creator";
  inputs[2]!.value = "https://example.com/work";
  form.listeners.get("input")!();
  assert.equal(submit.disabled, false, panel.all().map(el => el.textContent).join("\n"));
  assert.equal(reviews.length, 0, "draft typing must not navigate or persist");
  form.listeners.get("submit")!({ preventDefault() {} });
  assert.equal(reviews.length, 1);
  const route = parseAppFragment(reviews[0]!);
  assert.equal(route.route, "issue");
  if (route.route === "issue") {
    assert.notEqual(route.payload.requestId, receipt.request.requestId);
    assert.equal(route.payload.manifest.profile?.displayName, "Test Creator");
  }
  panel.all().find(el => el.textContent === "Cancel profile changes")!.listeners.get("click")!();
  assert.equal(panel.open, false);
  assert.equal(inputs[0]!.checked, false);
  assert.equal(inputs[1]!.value, "");
  inputs[0]!.checked = true; inputs[1]!.value = "Later"; form.listeners.get("input")!();
  signal.abort();
  form.listeners.get("submit")!({ preventDefault() {} });
  assert.equal(reviews.length, 1);
});
