import assert from "node:assert/strict";
import test from "node:test";

import { type Address } from "@solana/kit";

import {
  LOCAL_DEVNET_RPC_ENDPOINT,
  LocalDevnetKitRpcError,
  createHardPinnedLocalDevnetKitRpcFacade,
  createLocalDevnetKitRpcFacadeForTests,
} from "../src/local-devnet-kit-rpc.js";
import { SAS_PROGRAM_ID } from "../src/receipt.js";

const FIRST_ADDRESS =
  "11111111111111111111111111111111" as Address;
const SECOND_ADDRESS = SAS_PROGRAM_ID as Address;
const THIRD_ADDRESS =
  "SysvarRent111111111111111111111111111111111" as Address;
const OWNER_ADDRESS = SAS_PROGRAM_ID as Address;
const BLOCKHASH = "11111111111111111111111111111111";

function base64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function rawAccount(
  bytes: readonly number[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executable: false,
    lamports: 2_000_000n,
    owner: OWNER_ADDRESS,
    space: BigInt(bytes.length),
    data: [base64(bytes), "base64"],
    ...overrides,
  };
}

class RecordingTransport {
  genesisResponse: unknown =
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  latestResponse: unknown = {
    context: { slot: 10n },
    value: { blockhash: BLOCKHASH, lastValidBlockHeight: 200n },
  };
  blockHeightResponse: unknown = 150n;
  accountsResponse: unknown = {
    context: { slot: 11n },
    value: [rawAccount([1, 2, 3]), null, rawAccount([4, 5])],
  };
  feeResponse: unknown = { context: { slot: 12n }, value: 5_000n };
  rentResponse: unknown = 3_295_000n;
  balanceResponse: unknown = {
    context: { slot: 13n },
    value: 50_000_000n,
  };
  simulationResponse: unknown = {
    context: { slot: 14n },
    value: { err: null, logs: [], unitsConsumed: 42n },
  };
  throwMethod: string | undefined;

  readonly calls = {
    genesis: 0,
    latest: [] as unknown[],
    blockHeight: [] as unknown[],
    accounts: [] as Array<readonly [unknown, unknown]>,
    fee: [] as Array<readonly [unknown, unknown]>,
    rent: [] as Array<readonly [unknown, unknown]>,
    balance: [] as Array<readonly [unknown, unknown]>,
    simulation: [] as Array<readonly [unknown, unknown]>,
  };

  private maybeThrow(method: string): void {
    if (this.throwMethod === method) {
      throw new Error(
        "sensitive upstream detail: token=never-reflect https://private.invalid",
      );
    }
  }

  async getGenesisHash(): Promise<unknown> {
    this.calls.genesis += 1;
    this.maybeThrow("getGenesisHash");
    return this.genesisResponse;
  }

  async getLatestBlockhash(config: unknown): Promise<unknown> {
    this.calls.latest.push(config);
    this.maybeThrow("getLatestBlockhash");
    return this.latestResponse;
  }

  async getBlockHeight(config: unknown): Promise<unknown> {
    this.calls.blockHeight.push(config);
    this.maybeThrow("getBlockHeight");
    return this.blockHeightResponse;
  }

  async getMultipleAccounts(
    addresses: unknown,
    config: unknown,
  ): Promise<unknown> {
    this.calls.accounts.push([addresses, config]);
    this.maybeThrow("getMultipleAccounts");
    return this.accountsResponse;
  }

  async getFeeForMessage(
    messageBase64: unknown,
    config: unknown,
  ): Promise<unknown> {
    this.calls.fee.push([messageBase64, config]);
    this.maybeThrow("getFeeForMessage");
    return this.feeResponse;
  }

  async getMinimumBalanceForRentExemption(
    space: unknown,
    config: unknown,
  ): Promise<unknown> {
    this.calls.rent.push([space, config]);
    this.maybeThrow("getMinimumBalanceForRentExemption");
    return this.rentResponse;
  }

  async getBalance(
    accountAddress: unknown,
    config: unknown,
  ): Promise<unknown> {
    this.calls.balance.push([accountAddress, config]);
    this.maybeThrow("getBalance");
    return this.balanceResponse;
  }

  async simulateTransaction(
    transactionBase64: unknown,
    config: unknown,
  ): Promise<unknown> {
    this.calls.simulation.push([transactionBase64, config]);
    this.maybeThrow("simulateTransaction");
    return this.simulationResponse;
  }
}

function facade(transport: RecordingTransport) {
  return createLocalDevnetKitRpcFacadeForTests(transport);
}

function expectRpcRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalDevnetKitRpcError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("production factory has no URL parameter and constructs only the hard-pinned public Devnet facade", () => {
  assert.equal(LOCAL_DEVNET_RPC_ENDPOINT, "https://api.devnet.solana.com");
  assert.equal(createHardPinnedLocalDevnetKitRpcFacade.length, 0);

  // Kit does no I/O until a returned RPC plan's send() is invoked.
  const productionFacade = createHardPinnedLocalDevnetKitRpcFacade();
  assert.deepEqual(Object.keys(productionFacade).sort(), [
    "getBalance",
    "getBlockHeight",
    "getFeeForMessage",
    "getFinalizedMultipleAccounts",
    "getGenesisHash",
    "getLatestBlockhash",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    "simulateTransaction",
  ]);
  assert.equal(Object.isFrozen(productionFacade), true);
});

test("finalized enrollment read pins commitment and preserves ordered account bytes", async () => {
  const transport = new RecordingTransport();
  const rpc = facade(transport);
  const addresses = [THIRD_ADDRESS, FIRST_ADDRESS, SECOND_ADDRESS] as const;

  const accounts = await rpc.getFinalizedMultipleAccounts({
    addresses,
    commitment: "finalized",
    minContextSlot: 10n,
  });

  assert.deepEqual(transport.calls.accounts, [
    [
      addresses,
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot: 10n,
      },
    ],
  ]);
  assert.equal(accounts.contextSlot, 11n);
  assert.deepEqual(accounts.accounts[0], {
    address: THIRD_ADDRESS,
    programAddress: OWNER_ADDRESS,
    executable: false,
    lamports: 2_000_000n,
    space: 3n,
    data: Uint8Array.from([1, 2, 3]),
  });
  assert.equal(accounts.accounts[1], null);
  assert.deepEqual(accounts.accounts[2], {
    address: SECOND_ADDRESS,
    programAddress: OWNER_ADDRESS,
    executable: false,
    lamports: 2_000_000n,
    space: 2n,
    data: Uint8Array.from([4, 5]),
  });
});

test("maps every planner operation with exact confirmed/minContext and byte inputs", async () => {
  const transport = new RecordingTransport();
  const rpc = facade(transport);
  const addresses = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS] as const;

  assert.equal(
    await rpc.getGenesisHash(),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  assert.deepEqual(
    await rpc.getLatestBlockhash({ commitment: "confirmed" }),
    {
      contextSlot: 10n,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 200n,
    },
  );
  assert.equal(
    await rpc.getBlockHeight({
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    150n,
  );
  const accounts = await rpc.getMultipleAccounts({
    addresses,
    commitment: "confirmed",
    minContextSlot: 10n,
  });
  const fee = await rpc.getFeeForMessage({
    messageBytes: Uint8Array.from([9, 8, 7]),
    commitment: "confirmed",
    minContextSlot: 11n,
  });
  const rent = await rpc.getMinimumBalanceForRentExemption({
    space: 181n,
    commitment: "confirmed",
  });
  const balance = await rpc.getBalance({
    address: FIRST_ADDRESS,
    commitment: "confirmed",
    minContextSlot: 11n,
  });
  const simulation = await rpc.simulateTransaction({
    transactionBase64: base64([1, 2, 3, 4]),
    encoding: "base64",
    commitment: "confirmed",
    minContextSlot: 11n,
    sigVerify: false,
    replaceRecentBlockhash: false,
  });

  assert.deepEqual(transport.calls.latest, [{ commitment: "confirmed" }]);
  assert.deepEqual(transport.calls.blockHeight, [
    { commitment: "confirmed", minContextSlot: 10n },
  ]);
  assert.deepEqual(transport.calls.accounts, [
    [
      addresses,
      {
        encoding: "base64",
        commitment: "confirmed",
        minContextSlot: 10n,
      },
    ],
  ]);
  assert.deepEqual(transport.calls.fee, [
    [base64([9, 8, 7]), { commitment: "confirmed", minContextSlot: 11n }],
  ]);
  assert.deepEqual(transport.calls.rent, [
    [181n, { commitment: "confirmed" }],
  ]);
  assert.deepEqual(transport.calls.balance, [
    [
      FIRST_ADDRESS,
      { commitment: "confirmed", minContextSlot: 11n },
    ],
  ]);
  assert.deepEqual(transport.calls.simulation, [
    [
      base64([1, 2, 3, 4]),
      {
        encoding: "base64",
        commitment: "confirmed",
        minContextSlot: 11n,
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ],
  ]);

  assert.equal(accounts.contextSlot, 11n);
  assert.equal(accounts.accounts.length, 3);
  assert.deepEqual(accounts.accounts[0], {
    address: FIRST_ADDRESS,
    programAddress: OWNER_ADDRESS,
    executable: false,
    lamports: 2_000_000n,
    space: 3n,
    data: Uint8Array.from([1, 2, 3]),
  });
  assert.equal(accounts.accounts[1], null);
  assert.deepEqual(accounts.accounts[2], {
    address: THIRD_ADDRESS,
    programAddress: OWNER_ADDRESS,
    executable: false,
    lamports: 2_000_000n,
    space: 2n,
    data: Uint8Array.from([4, 5]),
  });
  assert.deepEqual(fee, { contextSlot: 12n, value: 5_000n });
  assert.equal(rent, 3_295_000n);
  assert.deepEqual(balance, { contextSlot: 13n, value: 50_000_000n });
  assert.deepEqual(simulation, {
    contextSlot: 14n,
    value: { err: null },
  });
  assert.equal(typeof fee.value, "bigint");
  assert.equal(typeof rent, "bigint");
  assert.equal(typeof balance.value, "bigint");
});

test("getMultipleAccounts preserves requested ordering and rejects mixed or malformed base64 account data", async () => {
  const addresses = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS] as const;

  const wrongCount = new RecordingTransport();
  wrongCount.accountsResponse = {
    context: { slot: 11n },
    value: [rawAccount([1]), null],
  };
  await expectRpcRejection(
    facade(wrongCount).getMultipleAccounts({
      addresses,
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /wrong number of accounts/u,
  );

  const wrongEncoding = new RecordingTransport();
  wrongEncoding.accountsResponse = {
    context: { slot: 11n },
    value: [
      rawAccount([1], { data: ["2", "base58"] }),
      null,
      rawAccount([2]),
    ],
  };
  await expectRpcRejection(
    facade(wrongEncoding).getMultipleAccounts({
      addresses,
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /was not returned as base64/u,
  );

  const malformedBase64 = new RecordingTransport();
  malformedBase64.accountsResponse = {
    context: { slot: 11n },
    value: [
      rawAccount([1], { data: ["A===", "base64"] }),
      null,
      rawAccount([2]),
    ],
  };
  await expectRpcRejection(
    facade(malformedBase64).getMultipleAccounts({
      addresses,
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /not canonical base64/u,
  );

  const mismatchedSpace = new RecordingTransport();
  mismatchedSpace.accountsResponse = {
    context: { slot: 11n },
    value: [rawAccount([1], { space: 2n }), null, rawAccount([2])],
  };
  await expectRpcRejection(
    facade(mismatchedSpace).getMultipleAccounts({
      addresses,
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /space does not match/u,
  );

  const mixedOwner = new RecordingTransport();
  mixedOwner.accountsResponse = {
    context: { slot: 11n },
    value: [
      rawAccount([1], { owner: "not-an-address" }),
      null,
      rawAccount([2]),
    ],
  };
  await expectRpcRejection(
    facade(mixedOwner).getMultipleAccounts({
      addresses,
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /owner is not a canonical Solana address/u,
  );
});

test("all numeric RPC facts require non-negative u64 bigints and fee alone may be null", async () => {
  const transport = new RecordingTransport();
  transport.feeResponse = { context: { slot: 12n }, value: null };
  assert.deepEqual(
    await facade(transport).getFeeForMessage({
      messageBytes: Uint8Array.from([1]),
      commitment: "confirmed",
      minContextSlot: 11n,
    }),
    { contextSlot: 12n, value: null },
  );

  const numericSlot = new RecordingTransport();
  numericSlot.latestResponse = {
    context: { slot: 10 },
    value: { blockhash: BLOCKHASH, lastValidBlockHeight: 200n },
  };
  await expectRpcRejection(
    facade(numericSlot).getLatestBlockhash({ commitment: "confirmed" }),
    /context slot is not a non-negative u64 bigint/u,
  );

  const numericHeight = new RecordingTransport();
  numericHeight.blockHeightResponse = 150;
  await expectRpcRejection(
    facade(numericHeight).getBlockHeight({
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /response is not a non-negative u64 bigint/u,
  );

  const stringFee = new RecordingTransport();
  stringFee.feeResponse = { context: { slot: 12n }, value: "5000" };
  await expectRpcRejection(
    facade(stringFee).getFeeForMessage({
      messageBytes: Uint8Array.from([1]),
      commitment: "confirmed",
      minContextSlot: 11n,
    }),
    /value is not a non-negative u64 bigint/u,
  );

  const negativeRent = new RecordingTransport();
  negativeRent.rentResponse = -1n;
  await expectRpcRejection(
    facade(negativeRent).getMinimumBalanceForRentExemption({
      space: 181n,
      commitment: "confirmed",
    }),
    /response is not a non-negative u64 bigint/u,
  );

  const oversizedBalance = new RecordingTransport();
  oversizedBalance.balanceResponse = {
    context: { slot: 13n },
    value: 18_446_744_073_709_551_616n,
  };
  await expectRpcRejection(
    facade(oversizedBalance).getBalance({
      address: FIRST_ADDRESS,
      commitment: "confirmed",
      minContextSlot: 11n,
    }),
    /value is not a non-negative u64 bigint/u,
  );
});

test("simulation forwards exact canonical creator wire and reduces arbitrary errors to a sentinel", async () => {
  const failed = new RecordingTransport();
  failed.simulationResponse = {
    context: { slot: 14n },
    value: {
      err: {
        confidentialUpstreamDetail: "do not reflect",
        InstructionError: [0, "Custom"],
      },
      logs: ["private log"],
    },
  };
  const result = await facade(failed).simulateTransaction({
    transactionBase64: base64([5, 6, 7]),
    encoding: "base64",
    commitment: "confirmed",
    minContextSlot: 11n,
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  assert.deepEqual(result, {
    contextSlot: 14n,
    value: { err: "simulation_failed" },
  });
  assert.doesNotMatch(
    JSON.stringify(result.value),
    /confidential|private log/u,
  );

  const missingErrorField = new RecordingTransport();
  missingErrorField.simulationResponse = {
    context: { slot: 14n },
    value: { logs: [] },
  };
  await expectRpcRejection(
    facade(missingErrorField).simulateTransaction({
      transactionBase64: base64([5, 6, 7]),
      encoding: "base64",
      commitment: "confirmed",
      minContextSlot: 11n,
      sigVerify: false,
      replaceRecentBlockhash: false,
    }),
    /value is missing err/u,
  );
});

test("malformed planner inputs fail before transport and cannot weaken simulation flags", async () => {
  const transport = new RecordingTransport();
  const rpc = facade(transport);

  await expectRpcRejection(
    rpc.getFinalizedMultipleAccounts({
      addresses: [FIRST_ADDRESS],
      commitment: "confirmed" as "finalized",
      minContextSlot: 10n,
    }),
    /commitment must be finalized/u,
  );
  await expectRpcRejection(
    rpc.getBlockHeight({
      commitment: "processed" as "confirmed",
      minContextSlot: 10n,
    }),
    /commitment must be confirmed/u,
  );
  await expectRpcRejection(
    rpc.getBalance({
      address: FIRST_ADDRESS,
      commitment: "confirmed",
      minContextSlot: -1n,
    }),
    /minContextSlot/u,
  );
  await expectRpcRejection(
    rpc.getFeeForMessage({
      messageBytes: new Uint8Array(),
      commitment: "confirmed",
      minContextSlot: 10n,
    }),
    /message bytes are empty/u,
  );
  await expectRpcRejection(
    rpc.simulateTransaction({
      transactionBase64: base64([1]),
      encoding: "base64",
      commitment: "confirmed",
      minContextSlot: 10n,
      sigVerify: true as false,
      replaceRecentBlockhash: false,
    }),
    /flags are not the exact safe planner flags/u,
  );
  await expectRpcRejection(
    rpc.simulateTransaction({
      transactionBase64: "A===",
      encoding: "base64",
      commitment: "confirmed",
      minContextSlot: 10n,
      sigVerify: false,
      replaceRecentBlockhash: false,
    }),
    /not canonical base64/u,
  );

  assert.equal(transport.calls.blockHeight.length, 0);
  assert.equal(transport.calls.accounts.length, 0);
  assert.equal(transport.calls.balance.length, 0);
  assert.equal(transport.calls.fee.length, 0);
  assert.equal(transport.calls.simulation.length, 0);
});

test("transport failures are sanitized and never reflect endpoint, token, or raw RPC detail", async () => {
  const transport = new RecordingTransport();
  transport.throwMethod = "getMultipleAccounts";
  const promise = facade(transport).getMultipleAccounts({
    addresses: [FIRST_ADDRESS],
    commitment: "confirmed",
    minContextSlot: 10n,
  });

  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalDevnetKitRpcError);
    assert.equal(
      error.message,
      "Local Devnet Kit RPC rejected response: getMultipleAccounts call failed",
    );
    assert.doesNotMatch(error.message, /token|private\.invalid|sensitive/u);
    return true;
  });
});
