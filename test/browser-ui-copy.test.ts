import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile("web/src/main.ts", "utf8");

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
