import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDevnetWallet,
  loadDevnetWallet,
} from "../src/devnet-wallet.js";

test("a Devnet-only signer survives a secure local round trip", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "velorn-devnet-wallet-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "wallet.json");
  const created = await createDevnetWallet(filePath);
  const loaded = await loadDevnetWallet(filePath);
  assert.equal(loaded.address, created.address);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(created.address));
});

test("wallet creation refuses to overwrite an existing secret", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "velorn-devnet-wallet-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "wallet.json");
  await createDevnetWallet(filePath);
  await assert.rejects(() => createDevnetWallet(filePath), /EEXIST/);
});
