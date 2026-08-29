import assert from "node:assert/strict";
import test from "node:test";

import { signature, type Signature } from "@solana/kit";

import {
  LOCAL_DEVNET_BROADCAST_RPC_ENDPOINT,
  LocalDevnetKitBroadcastError,
  createHardPinnedLocalDevnetKitBroadcastFacade,
  createLocalDevnetKitBroadcastFacadeForTests,
  type LocalDevnetKitBroadcastTransport,
} from "../src/local-devnet-kit-broadcast.js";
import { DEVNET_GENESIS_HASH } from "../src/receipt.js";
import { SOLANA_TRANSACTION_WIRE_LIMIT_BYTES } from "../src/sponsor-policy.js";

const TRANSACTION_SIGNATURE = signature("1".repeat(64));
const FINAL_WIRE_SHA256 = "ab".repeat(32);
const MIN_CONTEXT_SLOT = 400n;
const MIN_BLOCK_HEIGHT = 700n;
const TRANSACTION_SLOT = 450n;
const RESPONSE_CONTEXT_SLOT = 475n;
const FINALIZED_BLOCK_HEIGHT = 725n;

function canonicalBase64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function successfulStatus(overrides: Record<string, unknown> = {}) {
  return {
    slot: TRANSACTION_SLOT,
    confirmations: null,
    err: null,
    confirmationStatus: "finalized",
    status: { Ok: null },
    ...overrides,
  };
}

class RecordingTransport implements LocalDevnetKitBroadcastTransport {
  sendResponse: unknown = TRANSACTION_SIGNATURE;
  genesisResponse: unknown = DEVNET_GENESIS_HASH;
  statusesResponse: unknown = {
    context: { slot: RESPONSE_CONTEXT_SLOT },
    value: [successfulStatus()],
  };
  blockHeightResponse: unknown = FINALIZED_BLOCK_HEIGHT;
  throwMethod: string | undefined;

  readonly calls = {
    send: [] as Array<readonly [unknown, unknown]>,
    genesis: 0,
    statuses: [] as Array<readonly [unknown, unknown]>,
    blockHeight: [] as unknown[],
  };

  private maybeThrow(method: string): void {
    if (this.throwMethod === method) {
      throw new Error(
        "sensitive upstream token=never-reflect https://private.invalid",
      );
    }
  }

  async sendTransaction(
    exactTransactionBase64: string,
    config: Parameters<LocalDevnetKitBroadcastTransport["sendTransaction"]>[1],
  ): Promise<unknown> {
    this.calls.send.push([exactTransactionBase64, config]);
    this.maybeThrow("sendTransaction");
    return this.sendResponse;
  }

  async getGenesisHash(): Promise<unknown> {
    this.calls.genesis += 1;
    this.maybeThrow("getGenesisHash");
    return this.genesisResponse;
  }

  async getSignatureStatuses(
    signatures: readonly Signature[],
    config: Parameters<LocalDevnetKitBroadcastTransport["getSignatureStatuses"]>[1],
  ): Promise<unknown> {
    this.calls.statuses.push([signatures, config]);
    this.maybeThrow("getSignatureStatuses");
    return this.statusesResponse;
  }

  async getBlockHeight(
    config: Parameters<LocalDevnetKitBroadcastTransport["getBlockHeight"]>[0],
  ): Promise<unknown> {
    this.calls.blockHeight.push(config);
    this.maybeThrow("getBlockHeight");
    return this.blockHeightResponse;
  }
}

function facade(transport: RecordingTransport) {
  return createLocalDevnetKitBroadcastFacadeForTests(transport);
}

function statusInput(overrides: Record<string, unknown> = {}) {
  return {
    signature: TRANSACTION_SIGNATURE,
    finalWireSha256: FINAL_WIRE_SHA256,
    commitment: "finalized" as const,
    minContextSlot: MIN_CONTEXT_SLOT,
    minBlockHeight: MIN_BLOCK_HEIGHT,
    ...overrides,
  };
}

async function expectBroadcastRejection(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof LocalDevnetKitBroadcastError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("production factory has no endpoint parameter and owns a hard-pinned Devnet Kit client", () => {
  assert.equal(
    LOCAL_DEVNET_BROADCAST_RPC_ENDPOINT,
    "https://api.devnet.solana.com",
  );
  assert.equal(createHardPinnedLocalDevnetKitBroadcastFacade.length, 0);

  // Constructing a Kit RPC plan performs no network operation.
  const production = createHardPinnedLocalDevnetKitBroadcastFacade();
  assert.deepEqual(Object.keys(production).sort(), [
    "getFinalizedStatus",
    "sendExactTransaction",
  ]);
  assert.equal(Object.isFrozen(production), true);
});

test("submits the exact canonical base64 once with confirmed preflight and RPC retries disabled", async () => {
  const transport = new RecordingTransport();
  const rpc = facade(transport);
  const exactWire = canonicalBase64([0, 255, 1, 254, 2, 253]);

  assert.equal(
    await rpc.sendExactTransaction({
      transactionBase64: exactWire,
      encoding: "base64",
    }),
    TRANSACTION_SIGNATURE,
  );
  assert.deepEqual(transport.calls.send, [
    [
      exactWire,
      {
        encoding: "base64",
        preflightCommitment: "confirmed",
        skipPreflight: false,
        maxRetries: 0n,
      },
    ],
  ]);
});

test("rejects malformed, non-canonical, oversized, or expanded send requests before transport", async () => {
  const invalid: Array<readonly [string, Record<string, unknown>]> = [
    ["empty", { transactionBase64: "", encoding: "base64" }],
    ["unpadded", { transactionBase64: "AQ", encoding: "base64" }],
    ["padding bits", { transactionBase64: "Af==", encoding: "base64" }],
    ["wrong encoding", { transactionBase64: "AQ==", encoding: "base58" }],
    [
      "oversized",
      {
        transactionBase64: Buffer.alloc(
          SOLANA_TRANSACTION_WIRE_LIMIT_BYTES + 1,
        ).toString("base64"),
        encoding: "base64",
      },
    ],
    [
      "extra field",
      { transactionBase64: "AQ==", encoding: "base64", endpoint: "evil" },
    ],
  ];

  for (const [name, input] of invalid) {
    const transport = new RecordingTransport();
    await expectBroadcastRejection(
      facade(transport).sendExactTransaction(
        input as Parameters<
          ReturnType<typeof facade>["sendExactTransaction"]
        >[0],
      ),
      /send request|canonical bounded base64|encoding/u,
    );
    assert.equal(transport.calls.send.length, 0, name);
  }
});

test("validates returned send signatures and normalizes ambiguous transport errors without retry", async () => {
  const malformed = new RecordingTransport();
  malformed.sendResponse = "not-a-signature";
  await expectBroadcastRejection(
    facade(malformed).sendExactTransaction({
      transactionBase64: "AQ==",
      encoding: "base64",
    }),
    /canonical Solana signature/u,
  );
  assert.equal(malformed.calls.send.length, 1);

  const throwing = new RecordingTransport();
  throwing.throwMethod = "sendTransaction";
  await expectBroadcastRejection(
    facade(throwing).sendExactTransaction({
      transactionBase64: "AQ==",
      encoding: "base64",
    }),
    /sendTransaction failed/u,
  );
  assert.equal(throwing.calls.send.length, 1);
  await assert.rejects(
    facade(throwing).sendExactTransaction({
      transactionBase64: "AQ==",
      encoding: "base64",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /never-reflect|private\.invalid/u);
      return true;
    },
  );
});

test("binds one exact signature and wire hash to a successful finalized Devnet observation", async () => {
  const transport = new RecordingTransport();
  const result = await facade(transport).getFinalizedStatus(statusInput());

  assert.equal(transport.calls.genesis, 1);
  assert.deepEqual(transport.calls.statuses, [
    [[TRANSACTION_SIGNATURE], { searchTransactionHistory: true }],
  ]);
  assert.deepEqual(transport.calls.blockHeight, [
    { commitment: "finalized", minContextSlot: TRANSACTION_SLOT },
  ]);
  assert.deepEqual(result, {
    signature: TRANSACTION_SIGNATURE,
    finalWireSha256: FINAL_WIRE_SHA256,
    confirmationContextId: result.confirmationContextId,
    commitment: "finalized",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: TRANSACTION_SLOT,
    observedBlockHeight: FINALIZED_BLOCK_HEIGHT,
    signatureStatus: "confirmed",
  });
  assert.match(result.confirmationContextId, /^finalized:[0-9a-f]{64}$/u);

  const secondTransport = new RecordingTransport();
  const differentWire = await facade(secondTransport).getFinalizedStatus(
    statusInput({ finalWireSha256: "cd".repeat(32) }),
  );
  assert.notEqual(
    differentWire.confirmationContextId,
    result.confirmationContextId,
  );
});

test("rejects wrong genesis, stale contexts, missing statuses, failed statuses, and non-finalized statuses", async () => {
  const cases: Array<readonly [
    string,
    (transport: RecordingTransport) => void,
    RegExp,
  ]> = [
    [
      "wrong genesis",
      (transport) => {
        transport.genesisResponse = "wrong-cluster";
      },
      /not pinned Solana Devnet/u,
    ],
    [
      "stale response context",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: MIN_CONTEXT_SLOT - 1n },
          value: [successfulStatus()],
        };
      },
      /context is older/u,
    ],
    [
      "missing",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [null],
        };
      },
      /was not found/u,
    ],
    [
      "failed",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [successfulStatus({ err: { InstructionError: [0, "Bad"] } })],
        };
      },
      /not successful and finalized/u,
    ],
    [
      "confirmed only",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [successfulStatus({ confirmationStatus: "confirmed" })],
        };
      },
      /not successful and finalized/u,
    ],
    [
      "not rooted",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [successfulStatus({ confirmations: 0n })],
        };
      },
      /not successful and finalized/u,
    ],
    [
      "legacy failure",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [successfulStatus({ status: { Err: "failure" } })],
        };
      },
      /result is not successful/u,
    ],
    [
      "stale transaction slot",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: RESPONSE_CONTEXT_SLOT },
          value: [successfulStatus({ slot: MIN_CONTEXT_SLOT - 1n })],
        };
      },
      /status slot is older/u,
    ],
    [
      "impossible response chronology",
      (transport) => {
        transport.statusesResponse = {
          context: { slot: TRANSACTION_SLOT - 1n },
          value: [successfulStatus()],
        };
      },
      /newer than its response context/u,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const transport = new RecordingTransport();
    mutate(transport);
    await expectBroadcastRejection(
      facade(transport).getFinalizedStatus(statusInput()),
      pattern,
    );
    assert.equal(transport.calls.blockHeight.length, 0, name);
  }
});

test("rejects malformed status shapes, stale finalized block height, and invalid request bindings", async () => {
  const malformedShapes: unknown[] = [
    null,
    { context: { slot: RESPONSE_CONTEXT_SLOT }, value: [] },
    {
      context: { slot: RESPONSE_CONTEXT_SLOT },
      value: [successfulStatus(), successfulStatus()],
    },
    { context: { slot: "475" }, value: [successfulStatus()] },
    {
      context: { slot: RESPONSE_CONTEXT_SLOT },
      value: [successfulStatus({ status: null })],
    },
  ];
  for (const statusesResponse of malformedShapes) {
    const transport = new RecordingTransport();
    transport.statusesResponse = statusesResponse;
    await expectBroadcastRejection(
      facade(transport).getFinalizedStatus(statusInput()),
      /malformed|wrong number|u64 bigint/u,
    );
  }

  const staleHeight = new RecordingTransport();
  staleHeight.blockHeightResponse = MIN_BLOCK_HEIGHT - 1n;
  await expectBroadcastRejection(
    facade(staleHeight).getFinalizedStatus(statusInput()),
    /block height is older/u,
  );

  const invalidRequests: Array<readonly [string, Record<string, unknown>]> = [
    ["signature", { signature: "bad" }],
    ["hash", { finalWireSha256: "AB".repeat(32) }],
    ["commitment", { commitment: "confirmed" }],
    ["slot", { minContextSlot: -1n }],
    ["height", { minBlockHeight: "700" }],
    ["extra", { endpoint: "https://evil.invalid" }],
  ];
  for (const [name, overrides] of invalidRequests) {
    const transport = new RecordingTransport();
    await expectBroadcastRejection(
      facade(transport).getFinalizedStatus(
        statusInput(overrides) as Parameters<
          ReturnType<typeof facade>["getFinalizedStatus"]
        >[0],
      ),
      /request|signature|SHA-256|commitment|u64 bigint/u,
    );
    assert.equal(transport.calls.genesis, 0, name);
  }
});

test("normalizes confirmation transport failures and never retries a method", async () => {
  for (const method of [
    "getGenesisHash",
    "getSignatureStatuses",
    "getBlockHeight",
  ]) {
    const transport = new RecordingTransport();
    transport.throwMethod = method;
    await assert.rejects(
      facade(transport).getFinalizedStatus(statusInput()),
      (error: unknown) => {
        assert.ok(error instanceof LocalDevnetKitBroadcastError);
        assert.doesNotMatch(error.message, /never-reflect|private\.invalid/u);
        return true;
      },
    );
    assert.ok(transport.calls.genesis <= 1, method);
    assert.ok(transport.calls.statuses.length <= 1, method);
    assert.ok(transport.calls.blockHeight.length <= 1, method);
  }
});

test("rejects malformed injected transports during construction", () => {
  assert.throws(
    () =>
      createLocalDevnetKitBroadcastFacadeForTests(
        {} as LocalDevnetKitBroadcastTransport,
      ),
    /missing sendTransaction/u,
  );
});
