import {
  address,
  createSolanaRpc,
  devnet,
  getBase64Decoder,
  getBase64Encoder,
  type Address,
  type Base64EncodedWireTransaction,
  type ReadonlyUint8Array,
  type Slot,
  type TransactionMessageBytesBase64,
} from "@solana/kit";

import {
  SOLANA_TRANSACTION_WIRE_LIMIT_BYTES,
} from "./sponsor-policy.js";
import {
  type LocalDevnetContextValue,
  type LocalDevnetEncodedAccount,
  type LocalDevnetLatestBlockhashResponse,
  type LocalDevnetMultipleAccountsResponse,
  type LocalDevnetRpcFacade,
  type LocalDevnetSimulationValue,
} from "./local-devnet-planner.js";

/** The production factory below has no caller-supplied URL escape hatch. */
export const LOCAL_DEVNET_RPC_ENDPOINT =
  "https://api.devnet.solana.com" as const;

const COMMITMENT = "confirmed" as const;
const FINALIZED = "finalized" as const;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_CANONICAL_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;
const base64ToBytes = getBase64Encoder();
const bytesToBase64 = getBase64Decoder();

export class LocalDevnetKitRpcError extends Error {
  constructor(message: string) {
    super(`Local Devnet Kit RPC rejected response: ${message}`);
    this.name = "LocalDevnetKitRpcError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetKitRpcError(message);
}

interface ConfirmedConfig {
  readonly commitment: typeof COMMITMENT;
}

interface ConfirmedMinContextConfig extends ConfirmedConfig {
  readonly minContextSlot: bigint;
}

interface Base64AccountsConfig {
  readonly commitment: typeof COMMITMENT | typeof FINALIZED;
  readonly minContextSlot: bigint;
  readonly encoding: "base64";
}

interface SimulationConfig extends ConfirmedMinContextConfig {
  readonly encoding: "base64";
  readonly sigVerify: false;
  readonly replaceRecentBlockhash: false;
}

/**
 * Narrow method-specific seam used to test the mapping without a live network.
 * It is not an RPC proxy: callers cannot choose a method name, URL, headers, or
 * arbitrary parameters.
 */
interface LocalDevnetKitTransport {
  getGenesisHash(): Promise<unknown>;
  getLatestBlockhash(config: ConfirmedConfig): Promise<unknown>;
  getBlockHeight(config: ConfirmedMinContextConfig): Promise<unknown>;
  getMultipleAccounts(
    addresses: readonly Address[],
    config: Base64AccountsConfig,
  ): Promise<unknown>;
  getFeeForMessage(
    messageBase64: string,
    config: ConfirmedMinContextConfig,
  ): Promise<unknown>;
  getMinimumBalanceForRentExemption(
    space: bigint,
    config: ConfirmedConfig,
  ): Promise<unknown>;
  getBalance(
    accountAddress: Address,
    config: ConfirmedMinContextConfig,
  ): Promise<unknown>;
  simulateTransaction(
    transactionBase64: string,
    config: SimulationConfig,
  ): Promise<unknown>;
}

/**
 * Exact production surface used by the local flow. The additional account
 * read is intentionally finalized-only; it is not a caller-selectable RPC
 * commitment or generic method proxy.
 */
export interface LocalDevnetKitRpcFacade extends LocalDevnetRpcFacade {
  getFinalizedMultipleAccounts(input: {
    readonly addresses: readonly Address[];
    readonly commitment: typeof FINALIZED;
    readonly minContextSlot: bigint;
  }): Promise<LocalDevnetMultipleAccountsResponse>;
}

async function sanitizedCall<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof LocalDevnetKitRpcError) throw error;
    fail(`${label} call failed`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function u64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} is not a non-negative u64 bigint`);
  }
  return value;
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} is malformed`);
  try {
    return address(value);
  } catch {
    fail(`${label} is not a canonical Solana address`);
  }
}

function assertConfirmed(value: unknown): asserts value is typeof COMMITMENT {
  if (value !== COMMITMENT) fail("commitment must be confirmed");
}

function assertFinalized(value: unknown): asserts value is typeof FINALIZED {
  if (value !== FINALIZED) fail("commitment must be finalized");
}

function snapshotMinContextSlot(value: unknown): bigint {
  return u64(value, "minContextSlot");
}

function snapshotAddresses(values: readonly Address[]): readonly Address[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    fail("account address list must contain between 1 and 100 entries");
  }
  return Object.freeze(
    values.map((value, index) =>
      canonicalAddress(value, `requested account address ${index}`),
    ),
  );
}

function contextValue(
  value: unknown,
  label: string,
): Readonly<{ contextSlot: bigint; value: unknown }> {
  const response = record(value, `${label} response`);
  const context = record(response.context, `${label} response context`);
  return Object.freeze({
    contextSlot: u64(context.slot, `${label} response context slot`),
    value: response.value,
  });
}

function canonicalBase64ToBytes(
  value: unknown,
  label: string,
  maximumCharacters?: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    (maximumCharacters !== undefined && value.length > maximumCharacters) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail(`${label} is not canonical base64`);
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(base64ToBytes.encode(value));
  } catch {
    fail(`${label} is not decodable base64`);
  }
  if (bytesToBase64.decode(bytes) !== value) {
    fail(`${label} is not canonical base64`);
  }
  return bytes;
}

function exactMessageBase64(bytesInput: ReadonlyUint8Array): string {
  if (!(bytesInput instanceof Uint8Array)) {
    fail("exact message bytes are malformed");
  }
  const bytes = Uint8Array.from(bytesInput);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("exact message bytes are empty or oversized");
  }
  return bytesToBase64.decode(bytes);
}

function exactTransactionBase64(value: unknown): string {
  const bytes = canonicalBase64ToBytes(
    value,
    "exact creator transaction",
    MAX_CANONICAL_BASE64_CHARACTERS,
  );
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("exact creator transaction is empty or oversized");
  }
  return value as string;
}

function decodeAccount(
  value: unknown,
  requestedAddress: Address,
  index: number,
): LocalDevnetEncodedAccount | null {
  if (value === null) return null;
  const account = record(value, `account ${index}`);
  if (account.executable !== false && account.executable !== true) {
    fail(`account ${index} executable flag is malformed`);
  }
  const owner = canonicalAddress(account.owner, `account ${index} owner`);
  const lamports = u64(account.lamports, `account ${index} lamports`);
  const space = u64(account.space, `account ${index} space`);
  if (!Array.isArray(account.data) || account.data.length !== 2) {
    fail(`account ${index} data tuple is malformed`);
  }
  if (account.data[1] !== "base64") {
    fail(`account ${index} data was not returned as base64`);
  }
  const data = canonicalBase64ToBytes(
    account.data[0],
    `account ${index} data`,
  );
  if (space !== BigInt(data.byteLength)) {
    fail(`account ${index} space does not match decoded data`);
  }
  return Object.freeze({
    address: requestedAddress,
    programAddress: owner,
    executable: account.executable,
    lamports,
    space,
    data,
  });
}

async function readMultipleAccounts(
  transport: LocalDevnetKitTransport,
  input: {
    readonly addresses: readonly Address[];
    readonly commitment: unknown;
    readonly minContextSlot: bigint;
  },
  commitment: typeof COMMITMENT | typeof FINALIZED,
  label: "getMultipleAccounts" | "getFinalizedMultipleAccounts",
): Promise<LocalDevnetMultipleAccountsResponse> {
  if (commitment === COMMITMENT) {
    assertConfirmed(input.commitment);
  } else {
    assertFinalized(input.commitment);
  }
  const addresses = snapshotAddresses(input.addresses);
  const minContextSlot = snapshotMinContextSlot(input.minContextSlot);
  const raw = contextValue(
    await transport.getMultipleAccounts(
      addresses,
      Object.freeze({
        encoding: "base64",
        commitment,
        minContextSlot,
      }),
    ),
    label,
  );
  if (!Array.isArray(raw.value) || raw.value.length !== addresses.length) {
    fail(`${label} returned the wrong number of accounts`);
  }
  const accounts = raw.value.map((value, index) => {
    const requestedAddress = addresses[index];
    if (requestedAddress === undefined) {
      fail(`${label} request/response order is inconsistent`);
    }
    return decodeAccount(value, requestedAddress, index);
  });
  return Object.freeze({
    contextSlot: raw.contextSlot,
    accounts: Object.freeze(accounts),
  });
}

function createFacadeFromTransport(
  transport: LocalDevnetKitTransport,
): LocalDevnetKitRpcFacade {
  if (typeof transport !== "object" || transport === null) {
    throw new TypeError("Local Devnet Kit transport must be an object");
  }

  const facade: LocalDevnetKitRpcFacade = {
    async getGenesisHash(): Promise<string> {
      return sanitizedCall("getGenesisHash", async () => {
        const result = await transport.getGenesisHash();
        if (typeof result !== "string") {
          fail("getGenesisHash response is malformed");
        }
        return result;
      });
    },

    async getLatestBlockhash(input): Promise<LocalDevnetLatestBlockhashResponse> {
      return sanitizedCall("getLatestBlockhash", async () => {
        assertConfirmed(input.commitment);
        const raw = contextValue(
          await transport.getLatestBlockhash(
            Object.freeze({ commitment: COMMITMENT }),
          ),
          "getLatestBlockhash",
        );
        const value = record(raw.value, "getLatestBlockhash value");
        if (typeof value.blockhash !== "string") {
          fail("getLatestBlockhash blockhash is malformed");
        }
        return Object.freeze({
          contextSlot: raw.contextSlot,
          blockhash: value.blockhash,
          lastValidBlockHeight: u64(
            value.lastValidBlockHeight,
            "getLatestBlockhash lastValidBlockHeight",
          ),
        });
      });
    },

    async getBlockHeight(input): Promise<bigint> {
      return sanitizedCall("getBlockHeight", async () => {
        assertConfirmed(input.commitment);
        const minContextSlot = snapshotMinContextSlot(input.minContextSlot);
        return u64(
          await transport.getBlockHeight(
            Object.freeze({
              commitment: COMMITMENT,
              minContextSlot,
            }),
          ),
          "getBlockHeight response",
        );
      });
    },

    async getMultipleAccounts(
      input,
    ): Promise<LocalDevnetMultipleAccountsResponse> {
      return sanitizedCall("getMultipleAccounts", () =>
        readMultipleAccounts(
          transport,
          input,
          COMMITMENT,
          "getMultipleAccounts",
        ),
      );
    },

    async getFinalizedMultipleAccounts(
      input,
    ): Promise<LocalDevnetMultipleAccountsResponse> {
      return sanitizedCall("getFinalizedMultipleAccounts", () =>
        readMultipleAccounts(
          transport,
          input,
          FINALIZED,
          "getFinalizedMultipleAccounts",
        ),
      );
    },

    async getFeeForMessage(
      input,
    ): Promise<LocalDevnetContextValue<bigint | null>> {
      return sanitizedCall("getFeeForMessage", async () => {
        assertConfirmed(input.commitment);
        const minContextSlot = snapshotMinContextSlot(input.minContextSlot);
        const messageBase64 = exactMessageBase64(input.messageBytes);
        const raw = contextValue(
          await transport.getFeeForMessage(
            messageBase64,
            Object.freeze({
              commitment: COMMITMENT,
              minContextSlot,
            }),
          ),
          "getFeeForMessage",
        );
        return Object.freeze({
          contextSlot: raw.contextSlot,
          value:
            raw.value === null
              ? null
              : u64(raw.value, "getFeeForMessage value"),
        });
      });
    },

    async getMinimumBalanceForRentExemption(input): Promise<bigint> {
      return sanitizedCall(
        "getMinimumBalanceForRentExemption",
        async () => {
          assertConfirmed(input.commitment);
          const space = u64(input.space, "rent-exemption account space");
          return u64(
            await transport.getMinimumBalanceForRentExemption(
              space,
              Object.freeze({ commitment: COMMITMENT }),
            ),
            "getMinimumBalanceForRentExemption response",
          );
        },
      );
    },

    async getBalance(
      input,
    ): Promise<LocalDevnetContextValue<bigint>> {
      return sanitizedCall("getBalance", async () => {
        assertConfirmed(input.commitment);
        const accountAddress = canonicalAddress(
          input.address,
          "balance account address",
        );
        const minContextSlot = snapshotMinContextSlot(input.minContextSlot);
        const raw = contextValue(
          await transport.getBalance(
            accountAddress,
            Object.freeze({
              commitment: COMMITMENT,
              minContextSlot,
            }),
          ),
          "getBalance",
        );
        return Object.freeze({
          contextSlot: raw.contextSlot,
          value: u64(raw.value, "getBalance value"),
        });
      });
    },

    async simulateTransaction(
      input,
    ): Promise<LocalDevnetContextValue<LocalDevnetSimulationValue>> {
      return sanitizedCall("simulateTransaction", async () => {
        assertConfirmed(input.commitment);
        if (
          input.encoding !== "base64" ||
          input.sigVerify !== false ||
          input.replaceRecentBlockhash !== false
        ) {
          fail("simulation flags are not the exact safe planner flags");
        }
        const transactionBase64 = exactTransactionBase64(
          input.transactionBase64,
        );
        const minContextSlot = snapshotMinContextSlot(input.minContextSlot);
        const raw = contextValue(
          await transport.simulateTransaction(
            transactionBase64,
            Object.freeze({
              encoding: "base64",
              commitment: COMMITMENT,
              minContextSlot,
              sigVerify: false,
              replaceRecentBlockhash: false,
            }),
          ),
          "simulateTransaction",
        );
        const value = record(raw.value, "simulateTransaction value");
        if (!("err" in value)) {
          fail("simulateTransaction value is missing err");
        }
        return Object.freeze({
          contextSlot: raw.contextSlot,
          value: Object.freeze({
            // Never reflect arbitrary RPC error structures across this seam.
            err: value.err === null ? null : "simulation_failed",
          }),
        });
      });
    },
  };
  return Object.freeze(facade);
}

/**
 * Production local-only factory. It always owns exactly one Kit client bound
 * to the canonical public Devnet endpoint; there is no caller URL parameter.
 */
export function createHardPinnedLocalDevnetKitRpcFacade(): LocalDevnetKitRpcFacade {
  const rpc = createSolanaRpc(devnet(LOCAL_DEVNET_RPC_ENDPOINT));
  const transport: LocalDevnetKitTransport = {
      getGenesisHash: async () => rpc.getGenesisHash().send(),
      getLatestBlockhash: async (config) =>
        rpc.getLatestBlockhash(config).send(),
      getBlockHeight: async (config) =>
        rpc
          .getBlockHeight({
            commitment: config.commitment,
            minContextSlot: config.minContextSlot as Slot,
          })
          .send(),
      getMultipleAccounts: async (addresses, config) =>
        rpc
          .getMultipleAccounts(addresses, {
            encoding: config.encoding,
            commitment: config.commitment,
            minContextSlot: config.minContextSlot as Slot,
          })
          .send(),
      getFeeForMessage: async (messageBase64, config) =>
        rpc
          .getFeeForMessage(
            messageBase64 as TransactionMessageBytesBase64,
            {
              commitment: config.commitment,
              minContextSlot: config.minContextSlot as Slot,
            },
          )
          .send(),
      getMinimumBalanceForRentExemption: async (space, config) =>
        rpc
          .getMinimumBalanceForRentExemption(space, {
            commitment: config.commitment,
          })
          .send(),
      getBalance: async (accountAddress, config) =>
        rpc
          .getBalance(accountAddress, {
            commitment: config.commitment,
            minContextSlot: config.minContextSlot as Slot,
          })
          .send(),
      simulateTransaction: async (transactionBase64, config) =>
        rpc
          .simulateTransaction(
            transactionBase64 as Base64EncodedWireTransaction,
            {
              encoding: config.encoding,
              commitment: config.commitment,
              minContextSlot: config.minContextSlot as Slot,
              sigVerify: config.sigVerify,
              replaceRecentBlockhash: config.replaceRecentBlockhash,
            },
          )
          .send(),
    };
  return createFacadeFromTransport(Object.freeze(transport));
}

/** @internal Offline deterministic seam; never accepts an endpoint. */
export function createLocalDevnetKitRpcFacadeForTests(
  transport: LocalDevnetKitTransport,
): LocalDevnetKitRpcFacade {
  return createFacadeFromTransport(transport);
}
