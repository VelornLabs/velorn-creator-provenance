import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/pages.yml", "utf8");

function section(start: string, end: string): string {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing workflow marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing workflow marker: ${end}`);
  return workflow.slice(startIndex, endIndex);
}

test("Pages deploys only from the reviewed sprint branch", () => {
  const trigger = section("on:\n", "\nconcurrency:");

  assert.match(
    trigger,
    /^on:\n  push:\n    branches:\n      - codex\/eternal-sprint\n$/u,
  );
  assert.doesNotMatch(trigger, /pull_request|workflow_dispatch|\bmain\b/u);
});

test("each Pages job receives only its required permissions", () => {
  const build = section("  build:\n", "\n  deploy:");
  const deploy = workflow.slice(workflow.indexOf("  deploy:\n"));

  assert.match(
    build,
    /^  build:\n    permissions:\n      contents: read\n      pages: write\n/u,
  );
  assert.doesNotMatch(build, /id-token:/u);
  assert.match(
    deploy,
    /^  deploy:\n    permissions:\n      pages: write\n      id-token: write\n/u,
  );
  assert.doesNotMatch(deploy, /contents:/u);
});

test("the deployment is serialized and uses the GitHub Pages environment", () => {
  assert.match(
    workflow,
    /concurrency:\n  group: pages\n  cancel-in-progress: false/u,
  );
  assert.match(
    workflow,
    /deploy:\n    permissions:\n      pages: write\n      id-token: write\n    environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}\n    runs-on: ubuntu-latest\n    needs: build/u,
  );
});

test("all official deployment actions are pinned to reviewed commits", () => {
  const expectedActions = [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d",
    "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
    "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
  ];

  for (const action of expectedActions) {
    assert.match(workflow, new RegExp(`uses: ${action}`, "u"));
  }
  assert.doesNotMatch(workflow, /uses: [^\n]+@(v\d+|main|master)(?:\s|$)/u);
});

test("the build verifies evidence and the complete public app", () => {
  const requiredSteps = [
    "node-version: 22",
    "run: sha256sum -c evidence/SHA256SUMS",
    "run: npm ci",
    "run: npm test",
    "run: npm run build:web",
  ];
  let previousIndex = -1;

  for (const step of requiredSteps) {
    const index = workflow.indexOf(step);
    assert.notEqual(index, -1, `missing required Pages step: ${step}`);
    assert.ok(index > previousIndex, `${step} is out of order`);
    previousIndex = index;
  }

  assert.match(
    workflow,
    /- name: Build the public verifier\n        run: npm run build:web\n        env:\n          VITE_BUILD_SHA: \$\{\{ github\.sha \}\}/u,
  );
});

test("only the static verifier output is uploaded", () => {
  const upload = section(
    "      - name: Upload only the static public verifier",
    "\n\n  deploy:",
  );

  assert.match(
    upload,
    /uses: actions\/upload-pages-artifact@[0-9a-f]{40}[\s\S]*with:\n          path: \.\/dist\/web$/u,
  );
  assert.doesNotMatch(
    workflow,
    /build:devnet-web|dev:devnet|vite\.devnet|dist\/devnet|artifacts\/|\.local\/|\.env|secret|keypair/iu,
  );
});
