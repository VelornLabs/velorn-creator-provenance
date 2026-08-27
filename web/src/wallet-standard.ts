import {
  getWallets,
} from "@wallet-standard/app";
import type {
  Wallet,
  WalletAccount,
  WalletWithFeatures,
} from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import { SOLANA_DEVNET_CHAIN } from "@solana/wallet-standard-chains";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { address, getAddressEncoder } from "@solana/kit";

/**
 * Discovery and explicit authorization only. This module deliberately exposes
 * no transaction-signing, RPC, HTTP, persistence, or chain-write operation.
 */

export type CompatibleDevnetWallet = WalletWithFeatures<
  StandardConnectFeature &
    StandardEventsFeature &
    SolanaSignTransactionFeature
>;

export type DevnetWalletStatus =
  | "disconnected"
  | "connecting"
  | "selecting-account"
  | "connected"
  | "disposed";

export type WalletInvalidationReason =
  | "connect-failed"
  | "explicit-disconnect"
  | "wallet-change"
  | "wallet-unregistered";

export interface DevnetWalletSnapshot {
  readonly status: DevnetWalletStatus;
  readonly revision: number;
  readonly wallets: readonly CompatibleDevnetWallet[];
  readonly wallet: CompatibleDevnetWallet | null;
  readonly accounts: readonly WalletAccount[];
  readonly account: WalletAccount | null;
  readonly invalidation: WalletInvalidationReason | null;
}

export interface WalletRegistrySource {
  getWallets(): readonly Wallet[];
  onRegister(listener: () => void): () => void;
  onUnregister(listener: () => void): () => void;
}

export class WalletStandardValidationError extends Error {
  constructor(message: string) {
    super(`Wallet Standard rejected value: ${message}`);
    this.name = "WalletStandardValidationError";
  }
}

function fail(message: string): never {
  throw new WalletStandardValidationError(message);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function hasValidOptionalDisconnectFeature(
  features: Wallet["features"],
): boolean {
  const candidate = features[StandardDisconnect];
  if (candidate === undefined) return true;
  return (
    isRecord(candidate) &&
    candidate.version === "1.0.0" &&
    isFunction(candidate.disconnect)
  );
}

/**
 * A strict capability guard for the only Wallet Standard surface this Devnet
 * sprint supports. `solana:signTransaction` is checked for future handoff
 * compatibility but is never invoked by this discovery/connection slice.
 */
export function isCompatibleDevnetWallet(
  wallet: Wallet,
): wallet is CompatibleDevnetWallet {
  try {
    if (
      wallet.version !== "1.0.0" ||
      typeof wallet.name !== "string" ||
      wallet.name.length === 0 ||
      wallet.name !== wallet.name.trim() ||
      !Array.isArray(wallet.chains) ||
      !wallet.chains.includes(SOLANA_DEVNET_CHAIN) ||
      !isRecord(wallet.features)
    ) {
      return false;
    }

    const connect = wallet.features[StandardConnect];
    const events = wallet.features[StandardEvents];
    const signTransaction = wallet.features[SolanaSignTransaction];
    return (
      isRecord(connect) &&
      connect.version === "1.0.0" &&
      isFunction(connect.connect) &&
      isRecord(events) &&
      events.version === "1.0.0" &&
      isFunction(events.on) &&
      isRecord(signTransaction) &&
      signTransaction.version === "1.0.0" &&
      Array.isArray(signTransaction.supportedTransactionVersions) &&
      signTransaction.supportedTransactionVersions.includes("legacy") &&
      isFunction(signTransaction.signTransaction) &&
      hasValidOptionalDisconnectFeature(wallet.features)
    );
  } catch {
    return false;
  }
}

function bytesEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Validate that an account really represents the Devnet signing capability it
 * advertises, including agreement between its base58 address and public key.
 */
export function assertValidDevnetWalletAccount(
  account: WalletAccount,
): void {
  try {
    if (
      !Array.isArray(account.chains) ||
      !account.chains.includes(SOLANA_DEVNET_CHAIN) ||
      !Array.isArray(account.features) ||
      !account.features.includes(SolanaSignTransaction)
    ) {
      fail("account does not support Devnet legacy transaction signing");
    }
    if (typeof account.address !== "string") {
      fail("account address is not a string");
    }
    if (account.publicKey.byteLength !== 32) {
      fail("account public key must contain exactly 32 bytes");
    }

    const canonicalAddress = address(account.address);
    if (canonicalAddress !== account.address) {
      fail("account address is not canonical");
    }
    const encodedAddress = getAddressEncoder().encode(canonicalAddress);
    if (!bytesEqual(account.publicKey, encodedAddress)) {
      fail("account public key does not match its address");
    }
  } catch (error: unknown) {
    if (error instanceof WalletStandardValidationError) throw error;
    fail("account address or public key is malformed");
  }
}

function eligibleAccounts(value: unknown): readonly WalletAccount[] {
  if (!Array.isArray(value)) fail("connect result accounts must be an array");

  const eligible: WalletAccount[] = [];
  const addresses = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) fail("connect result contains a malformed account");
    const chains = candidate.chains;
    const features = candidate.features;
    if (!Array.isArray(chains) || !Array.isArray(features)) {
      fail("connect result contains a malformed account capability list");
    }
    if (
      !chains.includes(SOLANA_DEVNET_CHAIN) ||
      !features.includes(SolanaSignTransaction)
    ) {
      continue;
    }

    const account = candidate as unknown as WalletAccount;
    assertValidDevnetWalletAccount(account);
    if (addresses.has(account.address)) {
      fail("connect result contains duplicate Devnet account addresses");
    }
    addresses.add(account.address);
    eligible.push(account);
  }
  if (eligible.length === 0) {
    fail("wallet returned no eligible Devnet legacy-signing account");
  }
  return Object.freeze([...eligible]);
}

function compatibleWallets(
  source: WalletRegistrySource,
): readonly CompatibleDevnetWallet[] {
  const registered = source.getWallets();
  if (!Array.isArray(registered)) fail("wallet registry did not return an array");

  const seen = new Set<Wallet>();
  const compatible: CompatibleDevnetWallet[] = [];
  for (const wallet of registered) {
    if (seen.has(wallet)) continue;
    seen.add(wallet);
    if (isCompatibleDevnetWallet(wallet)) compatible.push(wallet);
  }
  return Object.freeze(compatible);
}

function createSnapshot(
  revision: number,
  status: DevnetWalletStatus,
  wallets: readonly CompatibleDevnetWallet[],
  wallet: CompatibleDevnetWallet | null = null,
  accounts: readonly WalletAccount[] = Object.freeze([]),
  account: WalletAccount | null = null,
  invalidation: WalletInvalidationReason | null = null,
): DevnetWalletSnapshot {
  return Object.freeze({
    status,
    revision,
    wallets,
    wallet,
    accounts,
    account,
    invalidation,
  });
}

export function createBrowserWalletRegistrySource(): WalletRegistrySource {
  const registry = getWallets();
  return Object.freeze({
    getWallets: () => registry.get(),
    onRegister: (listener: () => void) =>
      registry.on("register", () => listener()),
    onUnregister: (listener: () => void) =>
      registry.on("unregister", () => listener()),
  });
}

type SnapshotListener = (snapshot: DevnetWalletSnapshot) => void;

/**
 * Small framework-neutral controller for Wallet Standard discovery and
 * authorization. Any active-wallet change invalidates the local connection so
 * a later signing layer cannot accidentally reuse stale account assumptions.
 */
export class DevnetWalletConnection {
  readonly #source: WalletRegistrySource;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #stopRegistryListeners: readonly (() => void)[];
  #stopWalletEvents: (() => void) | undefined;
  #operation = 0;
  #snapshot: DevnetWalletSnapshot;

  constructor(source: WalletRegistrySource = createBrowserWalletRegistrySource()) {
    this.#source = source;
    this.#snapshot = createSnapshot(
      0,
      "disconnected",
      compatibleWallets(this.#source),
    );
    const refresh = () => this.#refreshDiscovery();
    this.#stopRegistryListeners = Object.freeze([
      this.#source.onRegister(refresh),
      this.#source.onUnregister(refresh),
    ]);
  }

  getSnapshot(): DevnetWalletSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(wallet: Wallet): Promise<DevnetWalletSnapshot> {
    this.#assertActive();
    if (this.#snapshot.status !== "disconnected") {
      fail("disconnect the current wallet operation before connecting");
    }
    const wallets = compatibleWallets(this.#source);
    if (!wallets.includes(wallet as CompatibleDevnetWallet)) {
      fail("wallet is not a currently registered compatible Devnet wallet");
    }
    const compatibleWallet = wallet as CompatibleDevnetWallet;
    const operation = ++this.#operation;
    this.#replace(
      "connecting",
      wallets,
      compatibleWallet,
      Object.freeze([]),
      null,
      null,
    );

    try {
      const result = await compatibleWallet.features[StandardConnect].connect();
      if (operation !== this.#operation || this.#isDisposed()) {
        return this.#snapshot;
      }

      const refreshedWallets = compatibleWallets(this.#source);
      if (!refreshedWallets.includes(compatibleWallet)) {
        this.#invalidate("wallet-unregistered", refreshedWallets);
        return this.#snapshot;
      }
      if (!isRecord(result)) fail("connect result must be an object");
      const accounts = eligibleAccounts(result.accounts);
      const stopEvents = compatibleWallet.features[StandardEvents].on(
        "change",
        () => this.#invalidate("wallet-change"),
      );
      if (typeof stopEvents !== "function") {
        fail("wallet events subscription did not return an unsubscribe function");
      }
      if (operation !== this.#operation || this.#isDisposed()) {
        this.#safelyStop(stopEvents);
        return this.#snapshot;
      }
      this.#stopWalletEvents = stopEvents;

      if (accounts.length === 1) {
        this.#replace(
          "connected",
          refreshedWallets,
          compatibleWallet,
          accounts,
          accounts[0] ?? null,
          null,
        );
      } else {
        this.#replace(
          "selecting-account",
          refreshedWallets,
          compatibleWallet,
          accounts,
          null,
          null,
        );
      }
      return this.#snapshot;
    } catch (error: unknown) {
      if (operation !== this.#operation || this.#isDisposed()) {
        return this.#snapshot;
      }
      this.#detachWalletEvents();
      this.#replace(
        "disconnected",
        compatibleWallets(this.#source),
        null,
        Object.freeze([]),
        null,
        "connect-failed",
      );
      throw error;
    }
  }

  selectAccount(accountAddress: string): DevnetWalletSnapshot {
    this.#assertActive();
    if (
      this.#snapshot.status !== "selecting-account" ||
      this.#snapshot.wallet === null
    ) {
      fail("there is no pending wallet account selection");
    }
    const account = this.#snapshot.accounts.find(
      (candidate) => candidate.address === accountAddress,
    );
    if (account === undefined) {
      fail("selected account was not returned by the connected wallet");
    }
    assertValidDevnetWalletAccount(account);
    this.#replace(
      "connected",
      this.#snapshot.wallets,
      this.#snapshot.wallet,
      this.#snapshot.accounts,
      account,
      null,
    );
    return this.#snapshot;
  }

  async disconnect(): Promise<DevnetWalletSnapshot> {
    this.#assertActive();
    if (this.#snapshot.status === "disconnected") return this.#snapshot;

    const wallet = this.#snapshot.wallet;
    this.#operation += 1;
    this.#detachWalletEvents();
    // Local state clears synchronously even when an optional wallet-extension
    // disconnect hook is absent, rejects, or never resolves. The extension's
    // own site authorization remains governed by that extension.
    this.#replace(
      "disconnected",
      compatibleWallets(this.#source),
      null,
      Object.freeze([]),
      null,
      "explicit-disconnect",
    );

    try {
      if (wallet !== null) {
        const feature = (wallet.features as Wallet["features"])[
          StandardDisconnect
        ] as
          | StandardDisconnectFeature[typeof StandardDisconnect]
          | undefined;
        await feature?.disconnect();
      }
    } catch (error: unknown) {
      // The local connection is already cleared. Surface the extension failure
      // without restoring stale account state or claiming deauthorization.
      throw error;
    }
    return this.#snapshot;
  }

  dispose(): void {
    if (this.#isDisposed()) return;
    this.#operation += 1;
    this.#detachWalletEvents();
    for (const stop of this.#stopRegistryListeners) this.#safelyStop(stop);
    this.#listeners.clear();
    this.#snapshot = createSnapshot(
      this.#snapshot.revision + 1,
      "disposed",
      Object.freeze([]),
    );
  }

  #assertActive(): void {
    if (this.#isDisposed()) fail("wallet connection has been disposed");
  }

  #isDisposed(): boolean {
    return this.#snapshot.status === "disposed";
  }

  #refreshDiscovery(): void {
    if (this.#isDisposed()) return;
    const wallets = compatibleWallets(this.#source);
    const activeWallet = this.#snapshot.wallet;
    if (activeWallet !== null && !wallets.includes(activeWallet)) {
      this.#invalidate("wallet-unregistered", wallets);
      return;
    }
    this.#replace(
      this.#snapshot.status,
      wallets,
      activeWallet,
      this.#snapshot.accounts,
      this.#snapshot.account,
      this.#snapshot.invalidation,
    );
  }

  #invalidate(
    reason: Exclude<WalletInvalidationReason, "connect-failed" | "explicit-disconnect">,
    wallets = compatibleWallets(this.#source),
  ): void {
    if (this.#isDisposed()) return;
    this.#operation += 1;
    this.#detachWalletEvents();
    this.#replace(
      "disconnected",
      wallets,
      null,
      Object.freeze([]),
      null,
      reason,
    );
  }

  #replace(
    status: DevnetWalletStatus,
    wallets: readonly CompatibleDevnetWallet[],
    wallet: CompatibleDevnetWallet | null,
    accounts: readonly WalletAccount[],
    account: WalletAccount | null,
    invalidation: WalletInvalidationReason | null,
  ): void {
    this.#snapshot = createSnapshot(
      this.#snapshot.revision + 1,
      status,
      wallets,
      wallet,
      accounts,
      account,
      invalidation,
    );
    for (const listener of [...this.#listeners]) listener(this.#snapshot);
  }

  #detachWalletEvents(): void {
    const stop = this.#stopWalletEvents;
    this.#stopWalletEvents = undefined;
    if (stop !== undefined) this.#safelyStop(stop);
  }

  #safelyStop(stop: () => void): void {
    try {
      stop();
    } catch {
      // Local state must still invalidate if an extension cleanup hook fails.
    }
  }
}
