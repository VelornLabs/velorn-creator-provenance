import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  address,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";

import { sha256HexPortable } from "../src/canonical-contract-runtime.js";
import { SAS_PROGRAM_ID, DEVNET_GENESIS_HASH } from "../src/solana-constants.js";
import {
  DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES,
  DEVNET_ISSUER_RPC_URL,
  DevnetIssuerRpcError,
  createDevnetIssuerRpc,
  createDevnetIssuerRpcForTests,
  type DevnetIssuerFetch,
} from "../web/src/devnet-issuer-rpc.js";

const CREATOR = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";
const SYSTEM_ADDRESS = "11111111111111111111111111111111";
const BLOCKHASH = SYSTEM_ADDRESS;
const TRANSACTION_BASE64 = "AQ==";
const OTHER_TRANSACTION_SIGNATURE =
  "66JFqNVHyfPdhSm4ywGyY4PB44o1T2MkuB2mhoY2Q859MsWaDn2f87AzT1yknxJVjALC3n5Z6KaMFakyjHpTn99A";

const feePayer = createNoopSigner(address(CREATOR));
const unsignedTransaction = compileTransaction(
  pipe(
    createTransactionMessage({ version: "legacy" }),
    (message) => setTransactionMessageFeePayerSigner(feePayer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 90n },
        message,
      ),
  ),
);
const signedTransaction = Object.freeze({
  ...unsignedTransaction,
  signatures: Object.freeze({
    [CREATOR]: Uint8Array.from({ length: 64 }, (_value, index) => index + 1) as SignatureBytes,
  }),
}) as Transaction;
const SIGNED_TRANSACTION_BYTES = Uint8Array.from(
  getTransactionEncoder().encode(signedTransaction),
);
const SIGNED_TRANSACTION_BASE64 = Buffer.from(SIGNED_TRANSACTION_BYTES).toString("base64");
const TRANSACTION_SIGNATURE = getSignatureFromTransaction(signedTransaction);

interface FetchCall {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
}

function rpcResponse(
  id: number,
  result: unknown,
  options: Readonly<{
    rawBody?: string;
    status?: number;
    contentType?: string;
    contentLength?: string;
    url?: string;
    redirected?: boolean;
    error?: unknown;
    extraEnvelopeField?: boolean;
  }> = {},
): Response {
  const envelope =
    options.rawBody ??
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(options.error === undefined
        ? { result }
        : { error: options.error }),
      ...(options.extraEnvelopeField ? { extra: true } : {}),
    });
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json; charset=utf-8",
    ...(options.contentLength === undefined
      ? {}
      : { "Content-Length": options.contentLength }),
  });
  const response = new Response(envelope, {
    status: options.status ?? 200,
    headers,
  });
  Object.defineProperties(response, {
    url: {
      value: options.url ?? `${DEVNET_ISSUER_RPC_URL}/`,
      configurable: true,
    },
    redirected: {
      value: options.redirected ?? false,
      configurable: true,
    },
  });
  return response;
}

class FetchQueue {
  readonly calls: FetchCall[] = [];
  readonly #responses: Array<Response | Error>;

  constructor(responses: readonly (Response | Error)[]) {
    this.#responses = [...responses];
  }

  readonly fetch: DevnetIssuerFetch = async (input, init) => {
    this.calls.push({ input, init });
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
}

function requestBody(call: FetchCall | undefined): Record<string, unknown> {
  assert.ok(call?.init);
  assert.equal(typeof call.init.body, "string");
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function assertCommonFetchPolicy(call: FetchCall | undefined): void {
  assert.ok(call?.init);
  assert.equal(call.input, DEVNET_ISSUER_RPC_URL);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.referrerPolicy, "no-referrer");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.mode, "cors");
  assert.ok(call.init.signal instanceof AbortSignal);
}

function assertRpcError(error: unknown, code: string): boolean {
  assert.ok(error instanceof DevnetIssuerRpcError);
  assert.equal(error.code, code);
  return true;
}

test("production surface is browser-only, fixed to Devnet, and has no endpoint parameter", async () => {
  const source = await readFile("web/src/devnet-issuer-rpc.ts", "utf8");

  assert.equal(DEVNET_ISSUER_RPC_URL, "https://api.devnet.solana.com");
  assert.match(source, /EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG/u);
  assert.equal(createDevnetIssuerRpc.length, 0);
  assert.doesNotMatch(source, /\bBuffer\b|from ["']node:|require\s*\(/u);
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+rpc/u);
  assert.match(source, /credentials: "omit"/u);
  assert.match(source, /referrerPolicy: "no-referrer"/u);
  assert.match(source, /redirect: "error"/u);
});

test("maps every issuer operation to one exact fixed JSON-RPC request", async () => {
  const queue = new FetchQueue([
    rpcResponse(1, DEVNET_GENESIS_HASH),
    rpcResponse(2, {
      context: { slot: 40 },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 90 },
    }),
    rpcResponse(3, 42),
    rpcResponse(4, {
      context: { slot: 43 },
      value: [
        {
          data: ["", "base64"],
          executable: false,
          lamports: 1_234,
          owner: SAS_PROGRAM_ID,
          rentEpoch: 0,
          space: 2,
        },
        null,
      ],
    }),
    rpcResponse(5, { context: { slot: 44 }, value: 5_000 }),
    rpcResponse(6, 12_345),
    rpcResponse(7, { context: { slot: 45 }, value: 99_000 }),
    rpcResponse(8, { context: { slot: 46 }, value: { err: null } }),
    rpcResponse(9, TRANSACTION_SIGNATURE),
    rpcResponse(10, {
      slot: 47,
      transaction: [SIGNED_TRANSACTION_BASE64, "base64"],
      meta: { err: null },
      version: "legacy",
    }),
    rpcResponse(11, {
      context: { slot: 48 },
      value: [
        {
          slot: 47,
          confirmations: null,
          err: null,
          confirmationStatus: "finalized",
          status: { Ok: null },
        },
      ],
    }),
    rpcResponse(12, { context: { slot: 49 }, value: false }),
  ]);
  const rpc = createDevnetIssuerRpcForTests(queue.fetch);

  await rpc.assertGenesis();
  assert.deepEqual(await rpc.getLatestBlockhash(), {
    contextSlot: 40n,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 90n,
  });
  assert.equal(
    await rpc.getBlockHeight({
      commitment: "confirmed",
      minContextSlot: 40n,
    }),
    42n,
  );
  const accounts = await rpc.getMultipleAccounts({
    addresses: [CREATOR, SYSTEM_ADDRESS],
    commitment: "confirmed",
    minContextSlot: 40n,
  });
  assert.equal(accounts.contextSlot, 43n);
  assert.deepEqual(accounts.accounts[0], {
    address: CREATOR,
    owner: SAS_PROGRAM_ID,
    executable: false,
    lamports: 1_234n,
    data: new Uint8Array(),
  });
  assert.equal(accounts.accounts[1], null);
  assert.deepEqual(
    await rpc.getFeeForMessage({
      messageBase64: TRANSACTION_BASE64,
      minContextSlot: 40n,
    }),
    { contextSlot: 44n, value: 5_000n },
  );
  assert.equal(
    await rpc.getMinimumBalanceForRentExemption({ space: 256n }),
    12_345n,
  );
  assert.deepEqual(
    await rpc.getBalance({
      accountAddress: CREATOR,
      minContextSlot: 40n,
    }),
    { contextSlot: 45n, value: 99_000n },
  );
  assert.deepEqual(
    await rpc.simulateExactTransaction({
      transactionBase64: TRANSACTION_BASE64,
      minContextSlot: 40n,
    }),
    { contextSlot: 46n, succeeded: true },
  );
  assert.equal(
    await rpc.sendExactSignedWireOnce({
      transactionBase64: SIGNED_TRANSACTION_BASE64,
      expectedSignature: TRANSACTION_SIGNATURE,
      minimumContextSlot: 40n,
    }),
    TRANSACTION_SIGNATURE,
  );
  assert.deepEqual(
    await rpc.getFinalizedTransaction({
      transactionSignature: TRANSACTION_SIGNATURE,
      minContextSlot: 40n,
    }),
    {
      slot: 47n,
      transactionBase64: SIGNED_TRANSACTION_BASE64,
      signedWireSha256: sha256HexPortable(SIGNED_TRANSACTION_BYTES),
    },
  );
  assert.deepEqual(
    await rpc.getSignatureStatus({
      transactionSignature: TRANSACTION_SIGNATURE,
      minContextSlot: 40n,
    }),
    {
      contextSlot: 48n,
      found: true,
      successful: true,
      confirmationStatus: "finalized",
      transactionSlot: 47n,
      confirmations: null,
    },
  );
  assert.deepEqual(
    await rpc.isBlockhashValid({
      recentBlockhash: BLOCKHASH,
      minContextSlot: 48n,
    }),
    { contextSlot: 49n, value: false },
  );

  assert.equal(queue.calls.length, 12);
  queue.calls.forEach(assertCommonFetchPolicy);
  assert.deepEqual(queue.calls.map((call) => requestBody(call)), [
    { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "getLatestBlockhash",
      params: [{ commitment: "confirmed" }],
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "getBlockHeight",
      params: [{ commitment: "confirmed", minContextSlot: 40 }],
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "getMultipleAccounts",
      params: [
        [CREATOR, SYSTEM_ADDRESS],
        {
          commitment: "confirmed",
          encoding: "base64",
          minContextSlot: 40,
        },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "getFeeForMessage",
      params: [
        TRANSACTION_BASE64,
        { commitment: "confirmed", minContextSlot: 40 },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "getMinimumBalanceForRentExemption",
      params: [256, { commitment: "confirmed" }],
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "getBalance",
      params: [
        CREATOR,
        { commitment: "confirmed", minContextSlot: 40 },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "simulateTransaction",
      params: [
        TRANSACTION_BASE64,
        {
          encoding: "base64",
          commitment: "confirmed",
          minContextSlot: 40,
          sigVerify: false,
          replaceRecentBlockhash: false,
        },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 9,
      method: "sendTransaction",
      params: [
        SIGNED_TRANSACTION_BASE64,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
          minContextSlot: 40,
        },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 10,
      method: "getTransaction",
      params: [
        TRANSACTION_SIGNATURE,
        {
          commitment: "finalized",
          encoding: "base64",
          maxSupportedTransactionVersion: 0,
        },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 11,
      method: "getSignatureStatuses",
      params: [
        [TRANSACTION_SIGNATURE],
        { searchTransactionHistory: true },
      ],
    },
    {
      jsonrpc: "2.0",
      id: 12,
      method: "isBlockhashValid",
      params: [
        BLOCKHASH,
        { commitment: "finalized", minContextSlot: 48 },
      ],
    },
  ]);
});

test("send marks the exact signature attempted before the ambiguous boundary and never retries", async () => {
  const queue = new FetchQueue([
    new Error("https://secret.invalid/?token=must-not-leak"),
  ]);
  const rpc = createDevnetIssuerRpcForTests(queue.fetch);
  const input = {
    transactionBase64: SIGNED_TRANSACTION_BASE64,
    expectedSignature: TRANSACTION_SIGNATURE,
    minimumContextSlot: 40n,
  } as const;

  await assert.rejects(rpc.sendExactSignedWireOnce(input), (error: unknown) => {
    assertRpcError(error, "UNAVAILABLE");
    assert.equal((error as Error).message.includes("secret"), false);
    assert.equal((error as Error).message.includes("token"), false);
    return true;
  });
  await assert.rejects(
    rpc.sendExactSignedWireOnce(input),
    (error) => assertRpcError(error, "ALREADY_ATTEMPTED"),
  );
  assert.equal(queue.calls.length, 1);
  const body = requestBody(queue.calls[0]);
  assert.equal(body.method, "sendTransaction");
  assert.deepEqual(body.params, [
    SIGNED_TRANSACTION_BASE64,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
      minContextSlot: 40,
    },
  ]);
});

test("send rejects a mismatched returned signature and still fences the wire", async () => {
  const queue = new FetchQueue([rpcResponse(1, OTHER_TRANSACTION_SIGNATURE)]);
  const rpc = createDevnetIssuerRpcForTests(queue.fetch);
  const input = {
    transactionBase64: SIGNED_TRANSACTION_BASE64,
    expectedSignature: TRANSACTION_SIGNATURE,
    minimumContextSlot: 40n,
  } as const;

  await assert.rejects(
    rpc.sendExactSignedWireOnce(input),
    (error) => assertRpcError(error, "INVALID_RESPONSE"),
  );
  await assert.rejects(
    rpc.sendExactSignedWireOnce(input),
    (error) => assertRpcError(error, "ALREADY_ATTEMPTED"),
  );
  assert.equal(queue.calls.length, 1);
});

test("send binds the caller expectation to the embedded signature before any side effect", async () => {
  let calls = 0;
  const rpc = createDevnetIssuerRpcForTests(async () => {
    calls += 1;
    throw new Error("must not fetch");
  });
  await assert.rejects(
    rpc.sendExactSignedWireOnce({
      transactionBase64: SIGNED_TRANSACTION_BASE64,
      expectedSignature: OTHER_TRANSACTION_SIGNATURE,
      minimumContextSlot: 40n,
    }),
    (error) => assertRpcError(error, "INVALID_INPUT"),
  );
  assert.equal(calls, 0);
});

test("send snapshots the exact validated wire before the external boundary", async () => {
  const queue = new FetchQueue([rpcResponse(1, TRANSACTION_SIGNATURE)]);
  const rpc = createDevnetIssuerRpcForTests(queue.fetch);
  let wireReads = 0;
  const input = {
    get transactionBase64(): string {
      wireReads += 1;
      return wireReads === 1 ? SIGNED_TRANSACTION_BASE64 : TRANSACTION_BASE64;
    },
    expectedSignature: TRANSACTION_SIGNATURE,
    minimumContextSlot: 40n,
  };

  assert.equal(await rpc.sendExactSignedWireOnce(input), TRANSACTION_SIGNATURE);
  assert.equal(wireReads, 1);
  assert.deepEqual(requestBody(queue.calls[0]).params, [
    SIGNED_TRANSACTION_BASE64,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
      minContextSlot: 40,
    },
  ]);
});

test("bounds, validates, and sanitizes every response envelope", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly response: Response;
    readonly code: string;
  }[] = [
    {
      name: "declared oversized body",
      response: rpcResponse(1, DEVNET_GENESIS_HASH, {
        contentLength: String(DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES + 1),
      }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "actual oversized body",
      response: rpcResponse(1, null, {
        rawBody: "x".repeat(DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES + 1),
      }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "wrong content type",
      response: rpcResponse(1, DEVNET_GENESIS_HASH, {
        contentType: "text/plain",
      }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "redirected",
      response: rpcResponse(1, DEVNET_GENESIS_HASH, { redirected: true }),
      code: "UNAVAILABLE",
    },
    {
      name: "cross origin",
      response: rpcResponse(1, DEVNET_GENESIS_HASH, {
        url: "https://attacker.example/",
      }),
      code: "UNAVAILABLE",
    },
    {
      name: "wrong request id",
      response: rpcResponse(2, DEVNET_GENESIS_HASH),
      code: "INVALID_RESPONSE",
    },
    {
      name: "extra envelope field",
      response: rpcResponse(1, DEVNET_GENESIS_HASH, {
        extraEnvelopeField: true,
      }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "malformed JSON",
      response: rpcResponse(1, null, { rawBody: "not-json" }),
      code: "INVALID_RESPONSE",
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const queue = new FetchQueue([candidate.response]);
      const rpc = createDevnetIssuerRpcForTests(queue.fetch);
      await assert.rejects(
        rpc.assertGenesis(),
        (error) => assertRpcError(error, candidate.code),
      );
      assert.equal(queue.calls.length, 1);
    });
  }

  await t.test("RPC error detail is not exposed", async () => {
    const queue = new FetchQueue([
      rpcResponse(1, null, {
        error: {
          code: -32000,
          message: "secret upstream detail and private token",
          data: { endpoint: "https://secret.invalid/" },
        },
      }),
    ]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(rpc.assertGenesis(), (error: unknown) => {
      assertRpcError(error, "RPC_REJECTED");
      assert.equal((error as Error).message.includes("secret"), false);
      assert.equal((error as Error).message.includes("token"), false);
      return true;
    });
  });
});

test("applies one deadline and caller cancellation across an unresponsive fetch", async () => {
  let timeoutSignal: AbortSignal | undefined;
  const timeoutRpc = createDevnetIssuerRpcForTests(
    async (_input, init) => {
      timeoutSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    },
    10,
  );
  await assert.rejects(
    timeoutRpc.assertGenesis(),
    (error) => assertRpcError(error, "TIMEOUT"),
  );
  assert.equal(timeoutSignal?.aborted, true);

  let cancelledSignal: AbortSignal | undefined;
  let calls = 0;
  const cancelledRpc = createDevnetIssuerRpcForTests(
    async (_input, init) => {
      calls += 1;
      cancelledSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    },
    1_000,
  );
  const controller = new AbortController();
  const pending = cancelledRpc.assertGenesis({ signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => assertRpcError(error, "CANCELLED"),
  );
  assert.equal(cancelledSignal?.aborted, true);
  assert.equal(calls, 1);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    cancelledRpc.assertGenesis({ signal: alreadyAborted.signal }),
    (error) => assertRpcError(error, "CANCELLED"),
  );
  assert.equal(calls, 1);
});

test("rejects malformed method results, stale contexts, and hostile input", async () => {
  {
    const queue = new FetchQueue([rpcResponse(1, "wrong-genesis")]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(
      rpc.assertGenesis(),
      (error) => assertRpcError(error, "WRONG_CLUSTER"),
    );
  }
  {
    const queue = new FetchQueue([
      rpcResponse(1, { context: { slot: 4 }, value: 1 }),
    ]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(
      rpc.getBalance({ accountAddress: CREATOR, minContextSlot: 5n }),
      (error) => assertRpcError(error, "INVALID_RESPONSE"),
    );
  }
  {
    const queue = new FetchQueue([
      rpcResponse(1, { context: { slot: 5 }, value: "false" }),
    ]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(
      rpc.isBlockhashValid({
        recentBlockhash: BLOCKHASH,
        minContextSlot: 5n,
      }),
      (error) => assertRpcError(error, "INVALID_RESPONSE"),
    );
  }
  {
    const queue = new FetchQueue([
      rpcResponse(1, {
        context: { slot: 5 },
        value: [{ owner: SAS_PROGRAM_ID, executable: false, lamports: 1, data: ["AB==", "base64"] }],
      }),
    ]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(
      rpc.getMultipleAccounts({
        addresses: [CREATOR],
        commitment: "confirmed",
        minContextSlot: 5n,
      }),
      (error) => assertRpcError(error, "INVALID_RESPONSE"),
    );
  }
  {
    let calls = 0;
    const rpc = createDevnetIssuerRpcForTests(async () => {
      calls += 1;
      throw new Error("must not fetch");
    });
    await assert.rejects(
      rpc.getFeeForMessage({ messageBase64: "AB==", minContextSlot: 0n }),
      (error) => assertRpcError(error, "INVALID_INPUT"),
    );
    await assert.rejects(
      rpc.getBalance({
        accountAddress: "https://attacker.example",
        minContextSlot: 0n,
      }),
      (error) => assertRpcError(error, "INVALID_INPUT"),
    );
    await assert.rejects(
      rpc.sendExactSignedWireOnce({
        transactionBase64: TRANSACTION_BASE64,
        expectedSignature: "not-a-signature",
        minimumContextSlot: 0n,
      }),
      (error) => assertRpcError(error, "INVALID_INPUT"),
    );
    assert.equal(calls, 0);
  }
});

test("rejects incoherent signature observations and finalized transaction evidence", async (t) => {
  const statusCases: readonly [string, Record<string, unknown>][] = [
    [
      "transaction slot ahead of response context",
      {
        slot: 6,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized",
        status: { Ok: null },
      },
    ],
    [
      "success status disagrees with error",
      {
        slot: 5,
        confirmations: null,
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "finalized",
        status: { Ok: null },
      },
    ],
    [
      "finalized still has confirmations",
      {
        slot: 5,
        confirmations: 2,
        err: null,
        confirmationStatus: "finalized",
        status: { Ok: null },
      },
    ],
    [
      "confirmed has zero confirmations",
      {
        slot: 5,
        confirmations: 0,
        err: null,
        confirmationStatus: "confirmed",
        status: { Ok: null },
      },
    ],
    [
      "processed has null confirmations",
      {
        slot: 5,
        confirmations: null,
        err: null,
        confirmationStatus: "processed",
        status: { Ok: null },
      },
    ],
    [
      "found status omits its confirmation stage",
      {
        slot: 5,
        confirmations: null,
        err: null,
        confirmationStatus: null,
        status: { Ok: null },
      },
    ],
  ];
  for (const [name, observed] of statusCases) {
    await t.test(name, async () => {
      const queue = new FetchQueue([
        rpcResponse(1, { context: { slot: 5 }, value: [observed] }),
      ]);
      const rpc = createDevnetIssuerRpcForTests(queue.fetch);
      await assert.rejects(
        rpc.getSignatureStatus({
          transactionSignature: TRANSACTION_SIGNATURE,
          minContextSlot: 4n,
        }),
        (error) => assertRpcError(error, "INVALID_RESPONSE"),
      );
    });
  }

  await t.test("finalized wire embeds a different signature", async () => {
    const queue = new FetchQueue([
      rpcResponse(1, {
        slot: 47,
        transaction: [SIGNED_TRANSACTION_BASE64, "base64"],
        meta: { err: null },
        version: "legacy",
      }),
    ]);
    const rpc = createDevnetIssuerRpcForTests(queue.fetch);
    await assert.rejects(
      rpc.getFinalizedTransaction({
        transactionSignature: OTHER_TRANSACTION_SIGNATURE,
        minContextSlot: 40n,
      }),
      (error) => assertRpcError(error, "INVALID_RESPONSE"),
    );
  });
});
