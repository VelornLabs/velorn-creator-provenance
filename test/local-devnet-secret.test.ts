import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createDevnetWallet } from "../src/devnet-wallet.js";
import {
  LocalDevnetSecretError,
  loadSecureLocalDevnetSponsor,
} from "../src/local-devnet-secret.js";

const temporaryRoots: string[] = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "velorn-local-sponsor-"));
  temporaryRoots.push(root);
  return root;
}

test("secure loader returns the fixed Devnet signer without exposing its seed", async () => {
  const root = await fixtureRoot();
  const walletPath = path.join(root, ".local", "devnet-payer.json");
  const created = await createDevnetWallet(walletPath);

  const loaded = await loadSecureLocalDevnetSponsor(root);
  assert.equal(loaded.address, created.address);
  assert.equal("privateKeyBase64" in loaded, false);
});

test("secure loader rejects loose directory or file permissions", async () => {
  const looseDirectoryRoot = await fixtureRoot();
  const directoryWallet = path.join(
    looseDirectoryRoot,
    ".local",
    "devnet-payer.json",
  );
  await createDevnetWallet(directoryWallet);
  await chmod(path.dirname(directoryWallet), 0o755);
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(looseDirectoryRoot),
    /directory permissions must be 700/u,
  );

  const looseFileRoot = await fixtureRoot();
  const looseWallet = path.join(looseFileRoot, ".local", "devnet-payer.json");
  await createDevnetWallet(looseWallet);
  await chmod(looseWallet, 0o644);
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(looseFileRoot),
    /wallet file permissions must be 600/u,
  );
});

test("secure loader rejects wallet and directory symlinks", async () => {
  const walletLinkRoot = await fixtureRoot();
  const local = path.join(walletLinkRoot, ".local");
  await mkdir(local, { mode: 0o700 });
  const target = path.join(walletLinkRoot, "target-wallet.json");
  await createDevnetWallet(target);
  await symlink(target, path.join(local, "devnet-payer.json"));
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(walletLinkRoot),
    /wallet path must be a real regular file/u,
  );

  const directoryLinkRoot = await fixtureRoot();
  const realLocal = path.join(directoryLinkRoot, "real-local");
  await mkdir(realLocal, { mode: 0o700 });
  await createDevnetWallet(path.join(realLocal, "devnet-payer.json"));
  await symlink(realLocal, path.join(directoryLinkRoot, ".local"));
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(directoryLinkRoot),
    /private wallet directory must be a real directory/u,
  );
});

test("secure loader rejects malformed, oversized, or extended wallet records", async () => {
  const root = await fixtureRoot();
  const local = path.join(root, ".local");
  const walletPath = path.join(local, "devnet-payer.json");
  await mkdir(local, { mode: 0o700 });
  await chmod(local, 0o700);

  await writeFile(walletPath, "not-json\n", { mode: 0o600 });
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(root),
    /not valid JSON/u,
  );

  const validRoot = await fixtureRoot();
  const validPath = path.join(validRoot, ".local", "devnet-payer.json");
  await createDevnetWallet(validPath);
  const original = JSON.parse(await readFile(validPath, "utf8")) as object;
  await writeFile(
    validPath,
    `${JSON.stringify({ ...original, unexpected: true })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(validRoot),
    /unsupported fields/u,
  );

  const unsupported = {
    format: "velorn-devnet-ed25519-seed-v1",
    cluster: "mainnet",
    privateKeyBase64: Buffer.alloc(32).toString("base64"),
  };
  await writeFile(validPath, `${JSON.stringify(unsupported)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(validRoot),
    /unsupported format/u,
  );

  await writeFile(
    validPath,
    `${JSON.stringify({
      ...unsupported,
      cluster: "devnet",
      privateKeyBase64: "A===",
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(validRoot),
    /unsupported format|canonical base64/u,
  );

  await writeFile(walletPath, "x".repeat(1_025), { mode: 0o600 });
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(root),
    /file size is outside/u,
  );
});

test("secure loader rejects special permission bits", async () => {
  const root = await fixtureRoot();
  const walletPath = path.join(root, ".local", "devnet-payer.json");
  await createDevnetWallet(walletPath);
  await chmod(walletPath, 0o4600);
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor(root),
    /wallet file permissions must be 600/u,
  );
});

test("secure loader accepts only an absolute trusted project root", async () => {
  await assert.rejects(
    () => loadSecureLocalDevnetSponsor("relative/project"),
    LocalDevnetSecretError,
  );
});
