import assert from "node:assert/strict";
import test from "node:test";

import {
  type StandardConnectInput,
  type StandardConnectOutput,
  type StandardEventsChangeProperties,
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
} from "@wallet-standard/features";
import type {
  IdentifierString,
  Wallet,
  WalletAccount,
} from "@wallet-standard/base";
import { SOLANA_DEVNET_CHAIN } from "@solana/wallet-standard-chains";
import {
  SolanaSignTransaction,
  type SolanaTransactionVersion,
} from "@solana/wallet-standard-features";
import { generateKeyPairSigner, getAddressEncoder } from "@solana/kit";

import {
  DevnetWalletConnection,
  WalletStandardValidationError,
  assertValidDevnetWalletAccount,
  isCompatibleDevnetWallet,
  type WalletRegistrySource,
} from "../web/src/wallet-standard.js";

const WALLET_ICON =
  "data:image/svg+xml;base64,PHN2Zy8+" as Wallet["icon"];

class MockWalletRegistry implements WalletRegistrySource {
  readonly #registered = new Set<() => void>();
  readonly #unregistered = new Set<() => void>();
  #wallets: Wallet[];

  constructor(wallets: readonly Wallet[] = []) {
    this.#wallets = [...wallets];
  }

  getWallets(): readonly Wallet[] {
    return [...this.#wallets];
  }

  onRegister(listener: () => void): () => void {
    this.#registered.add(listener);
    return () => {
      this.#registered.delete(listener);
    };
  }

  onUnregister(listener: () => void): () => void {
    this.#unregistered.add(listener);
    return () => {
      this.#unregistered.delete(listener);
    };
  }

  register(wallet: Wallet): void {
    this.#wallets.push(wallet);
    for (const listener of [...this.#registered]) listener();
  }

  unregister(wallet: Wallet): void {
    this.#wallets = this.#wallets.filter((candidate) => candidate !== wallet);
    for (const listener of [...this.#unregistered]) listener();
  }

  listenerCount(): number {
    return this.#registered.size + this.#unregistered.size;
  }
}

interface MockWalletOptions {
  readonly name?: string;
  readonly chains?: readonly IdentifierString[];
  readonly transactionVersions?: readonly SolanaTransactionVersion[];
  readonly accounts?: readonly WalletAccount[];
  readonly connect?: (
    input?: StandardConnectInput,
  ) => Promise<StandardConnectOutput>;
  readonly omitConnect?: boolean;
  readonly omitEvents?: boolean;
  readonly omitSignTransaction?: boolean;
  readonly includeDisconnect?: boolean;
  readonly disconnect?: () => Promise<void>;
  readonly malformedDisconnect?: boolean;
}

interface MockWalletControls {
  readonly wallet: Wallet;
  readonly connectInputs: readonly (StandardConnectInput | undefined)[];
  readonly signCalls: () => number;
  readonly disconnectCalls: () => number;
  readonly eventListenerCount: () => number;
  readonly emitChange: (properties?: StandardEventsChangeProperties) => void;
}

function createMockWallet(options: MockWalletOptions = {}): MockWalletControls {
  const eventListeners = new Set<
    (properties: StandardEventsChangeProperties) => void
  >();
  const connectInputs: (StandardConnectInput | undefined)[] = [];
  let signCallCount = 0;
  let disconnectCallCount = 0;
  const accounts = options.accounts ?? [];
  const features: Record<IdentifierString, unknown> = {};

  if (!options.omitConnect) {
    features[StandardConnect] = {
      version: "1.0.0",
      connect: async (input?: StandardConnectInput) => {
        connectInputs.push(input);
        if (options.connect) return options.connect(input);
        return { accounts };
      },
    };
  }
  if (!options.omitEvents) {
    features[StandardEvents] = {
      version: "1.0.0",
      on: (
        event: "change",
        listener: (properties: StandardEventsChangeProperties) => void,
      ) => {
        assert.equal(event, "change");
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
        };
      },
    };
  }
  if (!options.omitSignTransaction) {
    features[SolanaSignTransaction] = {
      version: "1.0.0",
      supportedTransactionVersions: options.transactionVersions ?? ["legacy"],
      signTransaction: async () => {
        signCallCount += 1;
        return [];
      },
    };
  }
  if (options.malformedDisconnect) {
    features[StandardDisconnect] = {
      version: "1.0.0",
      disconnect: "not-a-function",
    };
  } else if (options.includeDisconnect || options.disconnect !== undefined) {
    features[StandardDisconnect] = {
      version: "1.0.0",
      disconnect: async () => {
        disconnectCallCount += 1;
        await options.disconnect?.();
      },
    };
  }

  const chains: Wallet["chains"] = options.chains ?? [SOLANA_DEVNET_CHAIN];
  const wallet: Wallet = Object.freeze({
    version: "1.0.0",
    name: options.name ?? "Mock Devnet Wallet",
    icon: WALLET_ICON,
    chains,
    features,
    accounts,
  });
  return {
    wallet,
    connectInputs,
    signCalls: () => signCallCount,
    disconnectCalls: () => disconnectCallCount,
    eventListenerCount: () => eventListeners.size,
    emitChange: (properties = {}) => {
      for (const listener of [...eventListeners]) listener(properties);
    },
  };
}

async function createAccount(
  patch: Readonly<{
    address?: string;
    publicKey?: WalletAccount["publicKey"];
    chains?: WalletAccount["chains"];
    features?: WalletAccount["features"];
  }> = {},
): Promise<WalletAccount> {
  const signer = await generateKeyPairSigner();
  const chains: WalletAccount["chains"] = patch.chains ?? [
    SOLANA_DEVNET_CHAIN,
  ];
  const features: WalletAccount["features"] = patch.features ?? [
    SolanaSignTransaction,
  ];
  return Object.freeze({
    address: patch.address ?? signer.address,
    publicKey:
      patch.publicKey ?? getAddressEncoder().encode(signer.address),
    chains,
    features,
  });
}

test("capability guard requires Devnet, connect, events, and legacy signing", () => {
  assert.equal(isCompatibleDevnetWallet(createMockWallet().wallet), true);
  assert.equal(
    isCompatibleDevnetWallet(
      createMockWallet({ chains: ["solana:mainnet"] }).wallet,
    ),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(
      createMockWallet({ transactionVersions: [0] }).wallet,
    ),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(createMockWallet({ omitConnect: true }).wallet),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(createMockWallet({ omitEvents: true }).wallet),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(
      createMockWallet({ omitSignTransaction: true }).wallet,
    ),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(
      createMockWallet({ malformedDisconnect: true }).wallet,
    ),
    false,
  );
  assert.equal(
    isCompatibleDevnetWallet(createMockWallet({ name: " padded " }).wallet),
    false,
  );
});

test("account validation binds Devnet capability, address, and public key", async () => {
  const account = await createAccount();
  assert.doesNotThrow(() => assertValidDevnetWalletAccount(account));

  const other = await createAccount();
  assert.throws(
    () =>
      assertValidDevnetWalletAccount({
        ...account,
        publicKey: other.publicKey,
      }),
    /public key does not match/u,
  );
  assert.throws(
    () =>
      assertValidDevnetWalletAccount({
        ...account,
        features: [],
      }),
    /does not support Devnet legacy transaction signing/u,
  );
  assert.throws(
    () =>
      assertValidDevnetWalletAccount({
        ...account,
        address: "not-an-address",
      }),
    /address or public key is malformed/u,
  );
});

test("injected registry discovers compatible wallets and refreshes dynamically", () => {
  const registry = new MockWalletRegistry();
  const client = new DevnetWalletConnection(registry);
  const compatible = createMockWallet();
  const incompatible = createMockWallet({ transactionVersions: [0] });
  const revisions: number[] = [];
  client.subscribe((snapshot) => revisions.push(snapshot.revision));

  assert.deepEqual(client.getSnapshot().wallets, []);
  registry.register(incompatible.wallet);
  assert.deepEqual(client.getSnapshot().wallets, []);
  registry.register(compatible.wallet);
  assert.deepEqual(client.getSnapshot().wallets, [compatible.wallet]);
  registry.unregister(compatible.wallet);
  assert.deepEqual(client.getSnapshot().wallets, []);
  assert.equal(revisions.length, 3);

  client.dispose();
  assert.equal(registry.listenerCount(), 0);
});

test("explicit connect authorizes one valid account without signing", async () => {
  const account = await createAccount();
  const controls = createMockWallet({ accounts: [account] });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );
  const statuses: string[] = [];
  client.subscribe((snapshot) => statuses.push(snapshot.status));

  const connected = await client.connect(controls.wallet);
  assert.equal(connected.status, "connected");
  assert.equal(connected.wallet, controls.wallet);
  assert.equal(connected.account, account);
  assert.deepEqual(connected.accounts, [account]);
  assert.deepEqual(controls.connectInputs, [undefined]);
  assert.equal(controls.signCalls(), 0);
  assert.equal(controls.eventListenerCount(), 1);
  assert.deepEqual(statuses, ["connecting", "connected"]);

  client.dispose();
});

test("multiple eligible accounts require an explicit exact selection", async () => {
  const first = await createAccount();
  const second = await createAccount();
  const controls = createMockWallet({ accounts: [first, second] });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );

  const pending = await client.connect(controls.wallet);
  assert.equal(pending.status, "selecting-account");
  assert.equal(pending.account, null);
  assert.deepEqual(pending.accounts, [first, second]);
  assert.throws(
    () => client.selectAccount("11111111111111111111111111111111"),
    /was not returned/u,
  );

  const selected = client.selectAccount(second.address);
  assert.equal(selected.status, "connected");
  assert.equal(selected.account, second);
  assert.equal(controls.signCalls(), 0);

  client.dispose();
});

test("connect rejects malformed and duplicate eligible accounts", async () => {
  const valid = await createAccount();
  const wrongKey = await createAccount();
  const malformed = Object.freeze({
    ...valid,
    publicKey: wrongKey.publicKey,
  });
  const malformedWallet = createMockWallet({ accounts: [malformed] });
  const malformedClient = new DevnetWalletConnection(
    new MockWalletRegistry([malformedWallet.wallet]),
  );
  await assert.rejects(
    () => malformedClient.connect(malformedWallet.wallet),
    /public key does not match/u,
  );
  assert.equal(malformedClient.getSnapshot().status, "disconnected");
  assert.equal(
    malformedClient.getSnapshot().invalidation,
    "connect-failed",
  );
  malformedClient.dispose();

  const duplicateWallet = createMockWallet({ accounts: [valid, valid] });
  const duplicateClient = new DevnetWalletConnection(
    new MockWalletRegistry([duplicateWallet.wallet]),
  );
  await assert.rejects(
    () => duplicateClient.connect(duplicateWallet.wallet),
    /duplicate Devnet account addresses/u,
  );
  duplicateClient.dispose();
});

test("wallet change event invalidates the connected account and unsubscribes", async () => {
  const account = await createAccount();
  const controls = createMockWallet({ accounts: [account] });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );
  await client.connect(controls.wallet);

  controls.emitChange({ accounts: [] });
  const snapshot = client.getSnapshot();
  assert.equal(snapshot.status, "disconnected");
  assert.equal(snapshot.invalidation, "wallet-change");
  assert.equal(snapshot.wallet, null);
  assert.equal(snapshot.account, null);
  assert.deepEqual(snapshot.accounts, []);
  assert.equal(controls.eventListenerCount(), 0);

  client.dispose();
});

test("unregistering an active wallet invalidates the connection", async () => {
  const account = await createAccount();
  const controls = createMockWallet({ accounts: [account] });
  const registry = new MockWalletRegistry([controls.wallet]);
  const client = new DevnetWalletConnection(registry);
  await client.connect(controls.wallet);

  registry.unregister(controls.wallet);
  const snapshot = client.getSnapshot();
  assert.equal(snapshot.status, "disconnected");
  assert.equal(snapshot.invalidation, "wallet-unregistered");
  assert.deepEqual(snapshot.wallets, []);
  assert.equal(controls.eventListenerCount(), 0);

  client.dispose();
});

test("explicit disconnect invokes the optional feature and clears local state", async () => {
  const account = await createAccount();
  const controls = createMockWallet({
    accounts: [account],
    includeDisconnect: true,
  });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );
  await client.connect(controls.wallet);

  const disconnected = await client.disconnect();
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.invalidation, "explicit-disconnect");
  assert.equal(disconnected.wallet, null);
  assert.equal(disconnected.account, null);
  assert.equal(controls.disconnectCalls(), 1);
  assert.equal(controls.signCalls(), 0);

  client.dispose();
});

test("disconnect invalidates an in-flight connect result", async () => {
  const account = await createAccount();
  let resolveConnect: ((value: StandardConnectOutput) => void) | undefined;
  const delayed = new Promise<StandardConnectOutput>((resolve) => {
    resolveConnect = resolve;
  });
  const controls = createMockWallet({
    accounts: [account],
    connect: async () => delayed,
    includeDisconnect: true,
  });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );

  const connecting = client.connect(controls.wallet);
  assert.equal(client.getSnapshot().status, "connecting");
  await client.disconnect();
  resolveConnect?.({ accounts: [account] });
  const staleResult = await connecting;
  assert.equal(staleResult.status, "disconnected");
  assert.equal(staleResult.account, null);
  assert.equal(controls.eventListenerCount(), 0);
  assert.equal(controls.signCalls(), 0);

  client.dispose();
});

test("clearing without an optional disconnect feature is immediate and never signs", async () => {
  const account = await createAccount();
  let resolveConnect: ((value: StandardConnectOutput) => void) | undefined;
  const delayed = new Promise<StandardConnectOutput>((resolve) => {
    resolveConnect = resolve;
  });
  const controls = createMockWallet({
    accounts: [account],
    connect: async () => delayed,
  });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );

  const connecting = client.connect(controls.wallet);
  const cleared = await client.disconnect();
  assert.equal(cleared.status, "disconnected");
  assert.equal(cleared.invalidation, "explicit-disconnect");
  assert.equal(controls.disconnectCalls(), 0);
  assert.equal(controls.signCalls(), 0);

  resolveConnect?.({ accounts: [account] });
  assert.equal((await connecting).status, "disconnected");
  assert.equal(client.getSnapshot().account, null);
  assert.equal(controls.signCalls(), 0);
  client.dispose();
});

test("disposing during a pending connect cannot restore an account or sign", async () => {
  const account = await createAccount();
  let resolveConnect: ((value: StandardConnectOutput) => void) | undefined;
  const delayed = new Promise<StandardConnectOutput>((resolve) => {
    resolveConnect = resolve;
  });
  const controls = createMockWallet({
    accounts: [account],
    connect: async () => delayed,
  });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );

  const connecting = client.connect(controls.wallet);
  client.dispose();
  resolveConnect?.({ accounts: [account] });
  const stale = await connecting;
  assert.equal(stale.status, "disposed");
  assert.equal(stale.account, null);
  assert.equal(controls.signCalls(), 0);
});

test("a stale extension-disconnect failure cannot replace a newer connection", async () => {
  const account = await createAccount();
  let rejectDisconnect: ((reason?: unknown) => void) | undefined;
  const delayedDisconnect = new Promise<void>((_resolve, reject) => {
    rejectDisconnect = reject;
  });
  const controls = createMockWallet({
    accounts: [account],
    disconnect: async () => delayedDisconnect,
  });
  const client = new DevnetWalletConnection(
    new MockWalletRegistry([controls.wallet]),
  );

  await client.connect(controls.wallet);
  const staleDisconnect = client.disconnect();
  assert.equal(client.getSnapshot().status, "disconnected");
  const newer = await client.connect(controls.wallet);
  assert.equal(newer.status, "connected");
  rejectDisconnect?.(new Error("stale extension failure"));
  await assert.rejects(staleDisconnect, /stale extension failure/u);
  assert.equal(client.getSnapshot().status, "connected");
  assert.equal(client.getSnapshot().account, account);
  assert.equal(controls.signCalls(), 0);
  client.dispose();
});

test("unregistered wallets and disposed controllers fail closed", async () => {
  const account = await createAccount();
  const controls = createMockWallet({ accounts: [account] });
  const client = new DevnetWalletConnection(new MockWalletRegistry());
  await assert.rejects(
    () => client.connect(controls.wallet),
    WalletStandardValidationError,
  );

  client.dispose();
  assert.equal(client.getSnapshot().status, "disposed");
  assert.throws(
    () => client.subscribe(() => undefined),
    /has been disposed/u,
  );
  await assert.rejects(
    () => client.connect(controls.wallet),
    /has been disposed/u,
  );
});
