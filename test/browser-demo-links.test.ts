import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Hex } from "../src/commitment.js";
import {
  OFFLINE_DEMO_MEDIA_SHA256,
  OFFLINE_DEMO_REQUEST_ID,
  createOfflineDemoFragments,
} from "../web/src/demo-fixtures.js";
import { parseAppFragment } from "../web/src/fragment-contract.js";

test("offline reviewer links are deterministic and exercise both routes", () => {
  const first = createOfflineDemoFragments();
  const second = createOfflineDemoFragments();
  assert.deepEqual(first, second);
  assert.match(first.issue, /^#issue\/v1\//u);
  assert.match(first.verify, /^#verify\/v1\//u);

  const issue = parseAppFragment(first.issue);
  assert.equal(issue.route, "issue");
  if (issue.route !== "issue") return;
  assert.equal(issue.payload.requestId, OFFLINE_DEMO_REQUEST_ID);
  assert.equal(issue.payload.media.sha256, OFFLINE_DEMO_MEDIA_SHA256);
  assert.equal(
    issue.payload.manifest.profile?.displayName,
    "Sample Creator (offline fixture)",
  );

  const verify = parseAppFragment(first.verify);
  assert.equal(verify.route, "verify");
  if (verify.route !== "verify") return;
  assert.equal(verify.payload.request.requestId, OFFLINE_DEMO_REQUEST_ID);
  assert.equal(
    verify.payload.chainReceipt.credentialName,
    "VELORN-PROV-OFFLINE-DEMO",
  );
  assert.equal(
    verify.payload.chainReceipt.attestationAddress,
    "11111111111111111111111111111111",
  );
});

test("offline sample file matches the deterministic media commitment", async () => {
  const media = new Uint8Array(await readFile("fixtures/sample-export.txt"));
  assert.equal(sha256Hex(media), OFFLINE_DEMO_MEDIA_SHA256);

  const issue = parseAppFragment(createOfflineDemoFragments().issue);
  assert.equal(issue.route, "issue");
  if (issue.route !== "issue") return;
  assert.equal(issue.payload.manifest.media.byteLength, String(media.byteLength));
});

test("home copy labels samples and unissued commitment claims honestly", async () => {
  const mainSource = await readFile("web/src/main.ts", "utf8");
  assert.match(mainSource, /Open synthetic issue sample/u);
  assert.match(mainSource, /Open synthetic verifier sample/u);
  assert.match(mainSource, /not evidence of any on-chain attestation/u);
  assert.match(mainSource, /would be carried by an attestation transaction/u);
  assert.doesNotMatch(
    mainSource,
    /values are the compact public commitment carried by/u,
  );
});
