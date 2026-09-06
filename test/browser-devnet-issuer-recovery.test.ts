import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVNET_ISSUER_RECOVERY_CONTRACT,
  DEVNET_ISSUER_RECOVERY_LOCK_NAME,
  DEVNET_ISSUER_RECOVERY_NETWORK,
  DEVNET_ISSUER_RECOVERY_STORAGE_KEY,
  DEVNET_ISSUER_RECOVERY_STORE_CONTRACT,
  DEVNET_ISSUER_RECOVERY_VERSION,
  MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES,
  MAX_DEVNET_ISSUER_RECOVERY_RECORDS,
  MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES,
  clearDevnetIssuerRecoveryRecord,
  loadDevnetIssuerRecoveryRecord,
  saveDevnetIssuerRecoveryRecord,
  type DevnetIssuerRecoveryBinding,
  type DevnetIssuerRecoveryLock,
  type DevnetIssuerRecoveryStorage,
  type SaveDevnetIssuerRecoveryInput,
} from "../web/src/devnet-issuer-recovery.js";

const NOW = Date.parse("2026-09-03T18:30:00.000Z");
const CREATOR = "FrSCbpAawSmLejtM1x5bwx8xsNpq395vjiq84u3Mxjcy";
const CREDENTIAL = "AuyCUqEM2zobANdo3mpJkx8jBLxTPmG6vQ75FPEz9ePj";
const SCHEMA = "G6EUjJXivfjAAUYHc364ytZpBvWhD2bkajucskaU97wY";
const SUBJECT_NONCE = "GUAZRRhqNCemxFneomJfJKkBXKToVCQRbTaiTGAuTsVD";
const ATTESTATION = "BNA3gBtCV4WjgTzwCXZE3bTr98fqbHGfAn8emkCwdXAf";
const TRANSACTION_SIGNATURE =
  "2vSD8YQZqvR8JAPao6LDvXjwccGJqZsWV1VACn9NN7cFBmrSVNL3KKJyN3EtP4D62oumQKGQfk3tMMTeHe8zC7ZD";
const BLOCKHASH = "11111111111111111111111111111111";

class MemoryStorage implements DevnetIssuerRecoveryStorage {
  readonly values = new Map<string, string>();
  removals = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removals += 1;
    this.values.delete(key);
  }
}

class MemoryLock implements DevnetIssuerRecoveryLock {
  readonly calls: Array<readonly [string, string]> = [];
  #tail: Promise<void> = Promise.resolve();

  request<T>(
    name: string,
    options: Readonly<{ mode: "exclusive" }>,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    this.calls.push([name, options.mode]);
    const result = this.#tail.then(callback);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validInput(index = 1): SaveDevnetIssuerRecoveryInput {
  const digestByte = index.toString(16).padStart(2, "0");
  return {
    requestId: `request_devnet_recovery_${index.toString().padStart(4, "0")}`,
    requestHash: digestByte.repeat(32),
    creatorAuthority: CREATOR,
    credentialName: "VELORN-ABCDEFGHIJKLMNOPQRSTUVWXY",
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    subjectNonce: SUBJECT_NONCE,
    attestationAddress: ATTESTATION,
    intendedTransactionSignature: TRANSACTION_SIGNATURE,
    signedWireSha256: "34".repeat(32),
    recentBlockhash: BLOCKHASH,
    observedBlockHeight: "499999850",
    lastValidBlockHeight: "500000123",
    minimumContextSlot: "499999900",
    expiryUnixSeconds: "2000000000",
  };
}

function expectedBinding(index = 1, includeCreator = false): DevnetIssuerRecoveryBinding {
  const input = validInput(index);
  return includeCreator
    ? {
        requestId: input.requestId,
        requestHash: input.requestHash,
        creatorAuthority: input.creatorAuthority,
      }
    : { requestId: input.requestId, requestHash: input.requestHash };
}

function dependencies(storage: MemoryStorage, lock: MemoryLock, now = NOW) {
  return { storage, lock, now: () => now };
}

function savedStore(storage: MemoryStorage): Record<string, unknown> {
  const serialized = storage.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY);
  assert.notEqual(serialized, null);
  return JSON.parse(serialized ?? "") as Record<string, unknown>;
}

test("stores bounded public records under an exclusive same-origin lock", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const result = await saveDevnetIssuerRecoveryRecord(
    validInput(),
    dependencies(storage, lock),
  );
  const serialized = storage.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY);
  assert.ok(serialized);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(result.record)).byteLength <=
      MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES,
  );
  assert.ok(
    new TextEncoder().encode(serialized).byteLength <=
      MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES,
  );
  assert.equal(result.inserted, true);
  assert.equal(result.matchesInput, true);
  assert.equal(result.record.contract, DEVNET_ISSUER_RECOVERY_CONTRACT);
  assert.equal(result.record.version, DEVNET_ISSUER_RECOVERY_VERSION);
  assert.equal(result.record.network, DEVNET_ISSUER_RECOVERY_NETWORK);
  assert.equal(result.record.createdAt, "2026-09-03T18:30:00.000Z");
  assert.ok(Object.isFrozen(result.record));

  const store = savedStore(storage);
  assert.equal(store.contract, DEVNET_ISSUER_RECOVERY_STORE_CONTRACT);
  assert.equal(store.version, DEVNET_ISSUER_RECOVERY_VERSION);
  assert.equal((store.records as unknown[]).length, 1);
  const loaded = await loadDevnetIssuerRecoveryRecord(
    expectedBinding(1, true),
    dependencies(storage, lock),
  );
  assert.deepEqual(loaded, result.record);
  assert.equal(
    lock.calls.every(([name, mode]) =>
      name === DEVNET_ISSUER_RECOVERY_LOCK_NAME && mode === "exclusive"),
    true,
  );
});

test("rejects unsupported private fields before persistence", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const unsafe = {
    ...validInput(),
    mediaBytes: "private-media",
    filename: "private.mp4",
    localPath: "/private/file.mp4",
    walletMetadata: "private-wallet-name",
    signedTransactionBase64: "private-raw-wire",
  };
  await assert.rejects(
    saveDevnetIssuerRecoveryRecord(
      unsafe as unknown as SaveDevnetIssuerRecoveryInput,
      dependencies(storage, lock),
    ),
    /unsupported or missing properties/u,
  );
  assert.equal(storage.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY), null);
});

test("different request bindings coexist and a mismatch never deletes another request", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const first = await saveDevnetIssuerRecoveryRecord(validInput(1), dependencies(storage, lock));
  const second = await saveDevnetIssuerRecoveryRecord(validInput(2), dependencies(storage, lock));
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, true);
  assert.deepEqual(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(1), dependencies(storage, lock)),
    first.record,
  );
  assert.deepEqual(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(2), dependencies(storage, lock)),
    second.record,
  );
  assert.equal(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(3), dependencies(storage, lock)),
    null,
  );
  assert.equal((savedStore(storage).records as unknown[]).length, 2);
  assert.equal(storage.removals, 0);
});

test("same-binding saves are insert-only and distinguish exact from conflicting attempts", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const input = validInput();
  const first = await saveDevnetIssuerRecoveryRecord(input, dependencies(storage, lock));
  const exact = await saveDevnetIssuerRecoveryRecord(input, dependencies(storage, lock, NOW + 1_000));
  const conflicting = await saveDevnetIssuerRecoveryRecord(
    { ...input, signedWireSha256: "56".repeat(32) },
    dependencies(storage, lock, NOW + 2_000),
  );
  assert.equal(first.inserted, true);
  assert.deepEqual(exact, { record: first.record, inserted: false, matchesInput: true });
  assert.deepEqual(conflicting, {
    record: first.record,
    inserted: false,
    matchesInput: false,
  });
});

test("concurrent tabs serialize insert-only ownership of one request", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const firstInput = validInput();
  const secondInput = { ...firstInput, signedWireSha256: "78".repeat(32) };
  const [first, second] = await Promise.all([
    saveDevnetIssuerRecoveryRecord(firstInput, dependencies(storage, lock)),
    saveDevnetIssuerRecoveryRecord(secondInput, dependencies(storage, lock)),
  ]);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.matchesInput, false);
  assert.deepEqual(second.record, first.record);
});

test("compare-and-clear removes only an exact record", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const first = (await saveDevnetIssuerRecoveryRecord(validInput(1), dependencies(storage, lock))).record;
  const second = (await saveDevnetIssuerRecoveryRecord(validInput(2), dependencies(storage, lock))).record;
  assert.equal(
    await clearDevnetIssuerRecoveryRecord(
      { ...first, signedWireSha256: "90".repeat(32) },
      dependencies(storage, lock),
    ),
    false,
  );
  assert.equal(await clearDevnetIssuerRecoveryRecord(first, dependencies(storage, lock)), true);
  assert.equal(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(1), dependencies(storage, lock)),
    null,
  );
  assert.deepEqual(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(2), dependencies(storage, lock)),
    second,
  );
});

test("load and compare-and-clear snapshot callers before waiting on the lock", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const first = (
    await saveDevnetIssuerRecoveryRecord(validInput(1), dependencies(storage, lock))
  ).record;
  const second = (
    await saveDevnetIssuerRecoveryRecord(validInput(2), dependencies(storage, lock))
  ).record;

  const mutableBinding = { ...expectedBinding(1) } as Record<string, string>;
  const loading = loadDevnetIssuerRecoveryRecord(
    mutableBinding as unknown as DevnetIssuerRecoveryBinding,
    dependencies(storage, lock),
  );
  mutableBinding.requestId = second.requestId;
  mutableBinding.requestHash = second.requestHash;
  assert.deepEqual(await loading, first);

  const mutableRecord = { ...first } as Record<string, string | number>;
  const clearing = clearDevnetIssuerRecoveryRecord(
    mutableRecord as unknown as typeof first,
    dependencies(storage, lock),
  );
  mutableRecord.requestId = second.requestId;
  mutableRecord.requestHash = second.requestHash;
  assert.equal(await clearing, true);
  assert.equal(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(1), dependencies(storage, lock)),
    null,
  );
  assert.deepEqual(
    await loadDevnetIssuerRecoveryRecord(expectedBinding(2), dependencies(storage, lock)),
    second,
  );
});

test("records are never deleted solely because wall-clock time passed", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  const record = (
    await saveDevnetIssuerRecoveryRecord(
      validInput(),
      dependencies(storage, lock, Date.parse("2020-01-01T00:00:00.000Z")),
    )
  ).record;
  assert.deepEqual(
    await loadDevnetIssuerRecoveryRecord(
      expectedBinding(),
      dependencies(storage, lock, NOW),
    ),
    record,
  );
});

test("count and total serialized size are bounded without eviction", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  for (let index = 1; index <= MAX_DEVNET_ISSUER_RECOVERY_RECORDS; index += 1) {
    await saveDevnetIssuerRecoveryRecord(validInput(index), dependencies(storage, lock));
  }
  await assert.rejects(
    saveDevnetIssuerRecoveryRecord(validInput(9), dependencies(storage, lock)),
    /store is full/u,
  );
  assert.equal((savedStore(storage).records as unknown[]).length, MAX_DEVNET_ISSUER_RECOVERY_RECORDS);

  const oversized = new MemoryStorage();
  oversized.setItem(
    DEVNET_ISSUER_RECOVERY_STORAGE_KEY,
    "x".repeat(MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES + 1),
  );
  await assert.rejects(
    loadDevnetIssuerRecoveryRecord(expectedBinding(), dependencies(oversized, lock)),
    /total size limit/u,
  );
  assert.notEqual(oversized.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY), null);
});

test("malformed state and unavailable coordination fail closed without cleanup or network", async () => {
  const storage = new MemoryStorage();
  const lock = new MemoryLock();
  storage.setItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY, "{not-json");
  await assert.rejects(
    loadDevnetIssuerRecoveryRecord(expectedBinding(), dependencies(storage, lock)),
    /malformed/u,
  );
  assert.equal(storage.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY), "{not-json");

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("recovery must not fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      saveDevnetIssuerRecoveryRecord(validInput(), {
        storage: new MemoryStorage(),
        lock: { request: async () => { throw new Error("lock failed"); } },
        now: () => NOW,
      }),
      /coordination failed/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
});
