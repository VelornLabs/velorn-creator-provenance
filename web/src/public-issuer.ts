import {
  address,
  blockhash,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";

import { sha256HexPortable } from "../../src/canonical-contract-runtime.js";
import {
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
  type ShareableProvenanceReceiptV1,
} from "../../src/contracts.js";
import {
  createCreatorPaidProofPlan,
  decodeAndValidateCreatorPaidProofWire,
  decodeAndValidateSignedCreatorPaidProofWire,
  type CreatorPaidProofPlan,
} from "../../src/creator-paid-proof.js";
import { createAtomicCreatorPaidReceipt } from "../../src/creator-paid-receipt.js";
import { DEVNET_GENESIS_HASH } from "../../src/solana-constants.js";
import { verifyShareableReceiptOnDevnet } from "../../src/verify-chain.js";
import { signDevnetLegacyTransaction } from "./devnet-wallet-signing.js";
import {
  createDevnetIssuerRecoveryRecord,
} from "./devnet-issuer-recovery-adapter.js";
import type { DevnetIssuerRecoveryRecordV1 } from "./devnet-issuer-recovery.js";
import {
  createDevnetIssuerRpc,
  type DevnetIssuerRpc,
} from "./devnet-issuer-rpc.js";
import { publicVerifierUrl } from "./public-verifier-url.js";
import {
  DevnetWalletConnection,
  type DevnetWalletSnapshot,
} from "./wallet-standard.js";

/**
 * Explicit browser-only orchestration for a real #issue/v1 request. The module
 * is loaded only after the local file checker reports an exact hash match.
 * Mounting it performs no RPC, wallet authorization, signature, or send.
 */

const PROOF_TTL_SECONDS = 30n * 24n * 60n * 60n;
const MINIMUM_SIGNING_BLOCKS_REMAINING = 10n;
const AUTOMATIC_FINALITY_CHECKS = 30;
const FINALITY_POLL_MILLISECONDS = 1_200;
const MAX_USER_ERROR_CHARACTERS = 240;

export interface MountPublicCreatorPaidIssuerInput {
  readonly host: HTMLElement;
  readonly request: ProvenanceRequestV1;
  readonly signal: AbortSignal;
}

interface PreparedQuote {
  readonly plan: CreatorPaidProofPlan;
  readonly unsignedTransaction: Uint8Array;
  readonly feeLamports: bigint;
  readonly rentLamports: Readonly<{
    credential: bigint;
    schema: bigint;
    attestation: bigint;
    total: bigint;
  }>;
  readonly totalLamports: bigint;
  readonly balanceLamports: bigint;
}

type ResultTone = "neutral" | "working" | "match" | "mismatch";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (options.className) created.className = options.className;
  if (options.text !== undefined) created.textContent = options.text;
  return created;
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const normalized = error.message.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return fallback;
  if (normalized.length <= MAX_USER_ERROR_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_USER_ERROR_CHARACTERS - 1).trimEnd()}…`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < value.byteLength; offset += blockSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

function messageBase64(unsignedTransaction: Uint8Array): string {
  return encodeBase64(
    Uint8Array.from(
      getTransactionDecoder().decode(unsignedTransaction).messageBytes,
    ),
  );
}

function shortAddress(value: string): string {
  return value.length <= 20
    ? value
    : `${value.slice(0, 9)}…${value.slice(-9)}`;
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/u, "");
  return `${whole.toString()}${fraction.length > 0 ? `.${fraction}` : ""} Devnet SOL`;
}

function unixSecondsWithUtc(value: bigint): string {
  return `${new Date(Number(value) * 1_000).toISOString()} (${value.toString()} Unix seconds)`;
}

function row(label: string, value: string): HTMLElement {
  const wrapper = element("div", { className: "definition-row" });
  wrapper.append(
    element("dt", { text: label }),
    element("dd", { text: value }),
  );
  return wrapper;
}

function transactionExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function walletInvalidation(snapshot: DevnetWalletSnapshot): string | undefined {
  if (snapshot.invalidation === "wallet-change") {
    return "The wallet changed its account or capabilities. The prepared transaction was cleared; connect again.";
  }
  if (snapshot.invalidation === "wallet-unregistered") {
    return "The wallet extension is no longer available. The prepared transaction was cleared.";
  }
  if (snapshot.invalidation === "connect-failed") {
    return "The wallet did not complete a compatible Devnet connection.";
  }
  if (snapshot.invalidation === "explicit-disconnect") {
    return "The local wallet selection was cleared.";
  }
  return undefined;
}

export function mountPublicCreatorPaidIssuer(
  input: MountPublicCreatorPaidIssuerInput,
): void {
  if (!(input.host instanceof HTMLElement)) {
    throw new TypeError("The issuer host is unavailable.");
  }
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) return;

  const canonicalRequestJson = serializeCanonicalProvenanceRequestJson(
    input.request,
  );
  const requestHash = sha256HexPortable(canonicalRequestJson);
  const rpc: DevnetIssuerRpc = createDevnetIssuerRpc();
  const recoveryStore = createDevnetIssuerRecoveryRecord();

  const panel = element("section", { className: "panel issuer-panel" });
  const badge = element("span", {
    className: "status-badge",
    text: "Exact file matched · opt-in only",
  });
  const heading = element("h2", { text: "Create this proof on Solana Devnet" });
  const explanation = element("p", {
    className: "muted",
    text: "This sprint uses one creator-paid transaction to create a proof-scoped SAS credential, schema, and attestation atomically. Devnet SOL has no cash value. Your media remains local, and nothing is signed or submitted without separate clicks. Immediately before the one send attempt, this site stores a bounded same-origin public recovery record linking the request hash, public wallet, proof accounts, and transaction signature; it remains until you explicitly clear it.",
  });
  const status = element("div", { className: "hash-result neutral" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const details = element("div", { className: "issuer-details" });
  const actions = element("div", { className: "wallet-actions issuer-actions" });
  panel.append(badge, heading, explanation, status, details, actions);
  input.host.replaceChildren(panel);

  let disposed = false;
  let busy = false;
  let quote: PreparedQuote | undefined;
  let quoteNeedsRefresh = false;
  let recovery: DevnetIssuerRecoveryRecordV1 | undefined;
  let connection: DevnetWalletConnection | undefined;
  let stopConnection: (() => void) | undefined;
  let walletSnapshot: DevnetWalletSnapshot | undefined;
  let confirmedReceipt: ShareableProvenanceReceiptV1 | undefined;
  let recoveryCanClear = false;

  const setResult = (message: string, tone: ResultTone = "neutral"): void => {
    status.className = `hash-result ${tone}`;
    status.textContent = message;
  };

  const clearView = (): void => {
    details.replaceChildren();
    actions.replaceChildren();
  };

  const button = (
    label: string,
    activate: () => void,
    secondary = false,
  ): HTMLButtonElement => {
    const created = element("button", {
      className: secondary ? "secondary-button" : "wallet-button",
      text: label,
    });
    created.type = "button";
    created.addEventListener("click", activate);
    return created;
  };

  const showFailure = (error: unknown, fallback: string): void => {
    if (disposed || input.signal.aborted) return;
    setResult(safeMessage(error, fallback), "mismatch");
  };

  const ensureNotDisposed = (): void => {
    if (disposed || input.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  };

  const clearPreparedIfWalletChanged = (
    snapshot: DevnetWalletSnapshot,
  ): void => {
    if (
      quote !== undefined &&
      (snapshot.status !== "connected" ||
        snapshot.account?.address !== quote.plan.creatorAddress)
    ) {
      quote = undefined;
    }
  };

  const renderWallet = (): void => {
    if (disposed || busy || recovery !== undefined || confirmedReceipt !== undefined) {
      return;
    }
    clearView();
    const snapshot = walletSnapshot;
    if (snapshot === undefined) {
      setResult("Checking locally for a compatible wallet extension…", "working");
      return;
    }
    if (snapshot.status === "connecting") {
      setResult(`Waiting for ${snapshot.wallet?.name ?? "wallet"} authorization…`, "working");
      actions.append(
        button(
          "Cancel wallet connection",
          () => void connection?.disconnect().catch(() => undefined),
          true,
        ),
      );
      return;
    }
    if (snapshot.status === "selecting-account" && snapshot.wallet !== null) {
      setResult(
        `${snapshot.wallet.name} returned more than one Devnet account. Choose the public address that should assert this creator relationship.`,
      );
      for (const account of snapshot.accounts) {
        actions.append(
          button(`Use ${shortAddress(account.address)}`, () => {
            try {
              connection?.selectAccount(account.address);
            } catch (error: unknown) {
              showFailure(error, "That wallet account could not be selected.");
            }
          }),
        );
      }
      actions.append(
        button(
          "Clear local connection",
          () => void connection?.disconnect().catch(() => undefined),
          true,
        ),
      );
      return;
    }
    if (
      snapshot.status === "connected" &&
      snapshot.wallet !== null &&
      snapshot.account !== null
    ) {
      setResult(
        `${snapshot.wallet.name} account ${shortAddress(snapshot.account.address)} is selected. No RPC, signature, or transaction has been requested yet.`,
        "match",
      );
      const list = element("dl", { className: "definition-list" });
      list.append(
        row("Creator account", snapshot.account.address),
        row("Network", "Solana Devnet"),
        row("Payment", "Creator-paid with valueless Devnet SOL"),
      );
      details.append(list);
      actions.append(
        button("Prepare exact Devnet transaction", () => void prepareQuote()),
        button(
          "Clear local connection",
          () => void connection?.disconnect().catch(() => undefined),
          true,
        ),
      );
      return;
    }

    const invalidation = walletInvalidation(snapshot);
    if (snapshot.wallets.length === 0) {
      setResult(
        invalidation ??
          "No compatible Devnet Wallet Standard extension is detected. Phantom in Testnet Mode is supported.",
      );
      return;
    }
    setResult(
      invalidation ??
        "Compatible wallet metadata is available locally. Connecting only authorizes a public Devnet account; it does not sign or submit anything.",
    );
    for (const wallet of snapshot.wallets) {
      actions.append(
        button(`Connect ${wallet.name}`, () => {
          if (busy || connection === undefined) return;
          busy = true;
          clearView();
          setResult(
            `Waiting for ${wallet.name} authorization. Connecting does not sign or submit a transaction…`,
            "working",
          );
          let failureMessage: string | undefined;
          void connection
            .connect(wallet)
            .catch((error: unknown) => {
              failureMessage = safeMessage(
                error,
                `${wallet.name} connection was cancelled.`,
              );
            })
            .finally(() => {
              busy = false;
              renderWallet();
              if (failureMessage !== undefined) {
                setResult(failureMessage, "mismatch");
              }
            });
        }),
      );
    }
  };

  const ensureConnection = (): void => {
    if (connection !== undefined || disposed) return;
    try {
      connection = new DevnetWalletConnection();
      stopConnection = connection.subscribe((snapshot) => {
        walletSnapshot = snapshot;
        clearPreparedIfWalletChanged(snapshot);
        renderWallet();
      });
      walletSnapshot = connection.getSnapshot();
      renderWallet();
    } catch (error: unknown) {
      showFailure(error, "Wallet discovery is not available in this browser.");
    }
  };

  const renderReview = (message?: string): void => {
    if (quote === undefined || disposed) return;
    clearView();
    setResult(
      message ??
        "Review the exact public accounts and maximum quoted cost. The next click opens one wallet approval; submission follows only after Velorn verifies the returned transaction bytes.",
      message === undefined ? "neutral" : "mismatch",
    );
    const list = element("dl", { className: "definition-list" });
    list.append(
      row("Creator / fee payer", quote.plan.creatorAddress),
      row("Credential name", quote.plan.credentialName),
      row("Credential account", quote.plan.credentialAddress),
      row("Schema account", quote.plan.schemaAddress),
      row("Attestation account", quote.plan.attestationAddress),
      row("Media SHA-256", quote.plan.commitment.mediaSha256),
      row("Manifest SHA-256", quote.plan.commitment.manifestSha256),
      row("Statement type", quote.plan.commitment.statementType),
      row("Commitment version", quote.plan.commitment.version.toString()),
      row("Proof expiry", unixSecondsWithUtc(quote.plan.expiryUnixSeconds)),
      row("Network fee", sol(quote.feeLamports)),
      row("SAS account funding", sol(quote.rentLamports.total)),
      row("Maximum quoted total", sol(quote.totalLamports)),
      row("Current wallet balance", sol(quote.balanceLamports)),
      row("Wallet prompts remaining", "One"),
    );
    details.append(list);
    const disclosure = element("p", { className: "issuer-disclosure" });
    disclosure.textContent =
      "This creates three proof-scoped SAS accounts in one atomic Devnet transaction. It commits only the exact values above and reviewed public metadata; it does not upload the media or establish copyright. The recovery record contains public correlation data and can be read by other scripts on this same site origin or by someone with access to this browser profile.";
    details.append(disclosure);
    actions.append(
      quoteNeedsRefresh
        ? button("Refresh transaction", () => {
            if (busy || recovery !== undefined) return;
            quote = undefined;
            void prepareQuote();
          })
        : button("Approve and submit to Devnet", () => void signAndSubmit()),
      button(
        "Discard prepared transaction",
        () => {
          quote = undefined;
          renderWallet();
        },
        true,
      ),
    );
  };

  const prepareQuote = async (): Promise<void> => {
    if (busy || quote !== undefined || recovery !== undefined) return;
    const snapshot = walletSnapshot;
    if (
      snapshot?.status !== "connected" ||
      snapshot.wallet === null ||
      snapshot.account === null
    ) {
      showFailure(undefined, "Connect one compatible Devnet wallet first.");
      return;
    }
    busy = true;
    let failureMessage: string | undefined;
    quoteNeedsRefresh = false;
    clearView();
    setResult(
      "Reading the fixed Devnet endpoint, deriving the exact accounts, and simulating the unsigned transaction…",
      "working",
    );
    try {
      await rpc.assertGenesis({ signal: input.signal });
      const latest = await rpc.getLatestBlockhash({ signal: input.signal });
      const observedBlockHeight = await rpc.getBlockHeight({
        commitment: "confirmed",
        minContextSlot: latest.contextSlot,
        signal: input.signal,
      });
      const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1_000));
      const plan = await createCreatorPaidProofPlan({
        request: input.request,
        creatorAddress: address(snapshot.account.address),
        expiryUnixSeconds: nowUnixSeconds + PROOF_TTL_SECONDS,
        confirmedContext: {
          commitment: "confirmed",
          observedGenesisHash: DEVNET_GENESIS_HASH,
          observedSlot: latest.contextSlot,
          observedBlockHeight,
        },
        lifetimeConstraint: {
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
      });
      const unsignedTransaction = decodeBase64(plan.unsignedTransactionBase64);
      await decodeAndValidateCreatorPaidProofWire(unsignedTransaction, plan);

      const accountRead = await rpc.getMultipleAccounts({
        addresses: [
          plan.credentialAddress,
          plan.schemaAddress,
          plan.attestationAddress,
        ],
        commitment: "confirmed",
        minContextSlot: plan.confirmedContext.observedSlot,
        signal: input.signal,
      });
      if (accountRead.accounts.some((accountValue) => accountValue !== null)) {
        throw new Error(
          "One or more deterministic proof accounts already exist, so this page will not create a duplicate. Use the earlier receipt or prepare a new export request.",
        );
      }

      const [fee, credentialRent, schemaRent, attestationRent, balance, simulation] =
        await Promise.all([
          rpc.getFeeForMessage({
            messageBase64: messageBase64(unsignedTransaction),
            minContextSlot: plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
          rpc.getMinimumBalanceForRentExemption({
            space: BigInt(plan.accountDataSizes.credential),
            signal: input.signal,
          }),
          rpc.getMinimumBalanceForRentExemption({
            space: BigInt(plan.accountDataSizes.schema),
            signal: input.signal,
          }),
          rpc.getMinimumBalanceForRentExemption({
            space: BigInt(plan.accountDataSizes.attestation),
            signal: input.signal,
          }),
          rpc.getBalance({
            accountAddress: plan.creatorAddress,
            minContextSlot: plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
          rpc.simulateExactTransaction({
            transactionBase64: plan.unsignedTransactionBase64,
            minContextSlot: plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
        ]);
      if (fee.value === null) {
        throw new Error("Devnet could not quote this exact transaction fee.");
      }
      if (!simulation.succeeded) {
        throw new Error(
          "Devnet simulation rejected this exact transaction. Nothing was signed or submitted.",
        );
      }
      const rentTotal = credentialRent + schemaRent + attestationRent;
      const totalLamports = fee.value + rentTotal;
      if (balance.value < totalLamports) {
        throw new Error(
          `This account needs ${sol(totalLamports)} but currently has ${sol(balance.value)}. Add Devnet SOL and prepare again.`,
        );
      }
      ensureNotDisposed();
      if (
        walletSnapshot?.status !== "connected" ||
        walletSnapshot.account?.address !== plan.creatorAddress
      ) {
        throw new Error(
          "The selected wallet account changed while the transaction was being prepared.",
        );
      }
      quote = Object.freeze({
        plan,
        unsignedTransaction: Uint8Array.from(unsignedTransaction),
        feeLamports: fee.value,
        rentLamports: Object.freeze({
          credential: credentialRent,
          schema: schemaRent,
          attestation: attestationRent,
          total: rentTotal,
        }),
        totalLamports,
        balanceLamports: balance.value,
      });
    } catch (error: unknown) {
      quote = undefined;
      failureMessage = safeMessage(
        error,
        "The exact Devnet transaction could not be prepared.",
      );
    } finally {
      busy = false;
    }
    if (quote !== undefined) renderReview();
    else {
      renderWallet();
      if (failureMessage !== undefined) {
        setResult(failureMessage, "mismatch");
      }
    }
  };

  const renderRecovery = (
    message: string,
    tone: ResultTone = "neutral",
    allowActions = true,
  ): void => {
    if (recovery === undefined || disposed) return;
    clearView();
    setResult(message, tone);
    const list = element("dl", { className: "definition-list" });
    list.append(
      row("Creator", recovery.creatorAuthority),
      row("Attestation account", recovery.attestationAddress),
      row("Transaction signature", recovery.intendedTransactionSignature),
      row("Recovery mode", "Status checks only · never resubmit"),
    );
    details.append(list);
    const explorer = element("a", {
      className: "secondary-link",
      text: "Open this Devnet transaction in Solana Explorer",
    });
    explorer.href = transactionExplorerUrl(recovery.intendedTransactionSignature);
    explorer.target = "_blank";
    explorer.rel = "noopener noreferrer";
    details.append(explorer);
    if (!allowActions) return;
    actions.append(
      button("Check pending proof status", () => void startRecoveryCheck()),
    );
    if (recoveryCanClear) {
      actions.append(
        button(
          "Clear completed attempt and start over",
          () => void (async () => {
            const expected = recovery;
            if (expected === undefined || busy) return;
            busy = true;
            try {
              const cleared = await recoveryStore.clear(expected);
              if (!cleared) {
                renderRecovery(
                  "The saved attempt changed in another tab, so nothing was cleared. This page remains in status-only recovery.",
                  "neutral",
                );
                return;
              }
              recovery = undefined;
              recoveryCanClear = false;
              ensureConnection();
              busy = false;
              renderWallet();
            } catch (error: unknown) {
              showFailure(error, "The local recovery record could not be cleared.");
            } finally {
              busy = false;
            }
          })(),
          true,
        ),
      );
    }
  };

  const showConfirmed = (
    receipt: ShareableProvenanceReceiptV1,
    record: DevnetIssuerRecoveryRecordV1,
  ): void => {
    confirmedReceipt = receipt;
    recovery = record;
    quote = undefined;
    clearView();
    badge.textContent = "Finalized and independently checked";
    setResult(
      "The exact creator-paid provenance proof is finalized on Solana Devnet.",
      "match",
    );
    const list = element("dl", { className: "definition-list" });
    list.append(
      row("Creator", receipt.chainReceipt.authorizedSigner),
      row("Attestation account", receipt.chainReceipt.attestationAddress),
      row(
        "Finalized transaction",
        receipt.chainReceipt.transactions.createAttestation.signature,
      ),
    );
    details.append(list);
    const verifier = element("a", {
      className: "primary-link",
      text: "Open the public verifier",
    });
    verifier.href = publicVerifierUrl(receipt);
    verifier.target = "_blank";
    verifier.rel = "noopener noreferrer";
    const explorer = element("a", {
      className: "secondary-link",
      text: "Open finalized Devnet transaction",
    });
    explorer.href = transactionExplorerUrl(
      receipt.chainReceipt.transactions.createAttestation.signature,
    );
    explorer.target = "_blank";
    explorer.rel = "noopener noreferrer";
    const forgetRecovery = button(
      "Forget saved recovery after preserving the verifier link",
      () => void (async () => {
        if (busy) return;
        busy = true;
        try {
          const cleared = await recoveryStore.clear(record);
          if (!cleared) {
            setResult(
              "The proof remains finalized, but the saved recovery changed in another tab and was not cleared.",
              "neutral",
            );
            return;
          }
          recovery = undefined;
          recoveryCanClear = false;
          forgetRecovery.remove();
          setResult(
            "The proof remains finalized. The same-origin recovery copy was explicitly cleared; keep the verifier link as your durable handoff.",
            "match",
          );
        } catch (error: unknown) {
          setResult(
            safeMessage(error, "The finalized proof is safe, but its local recovery copy could not be cleared."),
            "neutral",
          );
        } finally {
          busy = false;
        }
      })(),
      true,
    );
    actions.append(verifier, explorer, forgetRecovery);
  };

  const finalizeRecovery = async (
    record: DevnetIssuerRecoveryRecordV1,
  ): Promise<boolean> => {
    const plan = await createCreatorPaidProofPlan({
      request: input.request,
      creatorAddress: address(record.creatorAuthority),
      expiryUnixSeconds: BigInt(record.expiryUnixSeconds),
      confirmedContext: {
        commitment: "confirmed",
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot: BigInt(record.minimumContextSlot),
        observedBlockHeight: BigInt(record.observedBlockHeight),
      },
      lifetimeConstraint: {
        blockhash: blockhash(record.recentBlockhash),
        lastValidBlockHeight: BigInt(record.lastValidBlockHeight),
      },
    });
    if (
      plan.canonicalRequestSha256 !== record.requestHash ||
      plan.credentialName !== record.credentialName ||
      plan.credentialAddress !== record.credentialAddress ||
      plan.schemaAddress !== record.schemaAddress ||
      plan.subjectNonce !== record.subjectNonce ||
      plan.attestationAddress !== record.attestationAddress
    ) {
      renderRecovery(
        "The saved recovery identifiers do not match the deterministic request plan. This page will not publish or clear a receipt.",
        "mismatch",
      );
      return false;
    }
    const finalizedTransaction = await rpc.getFinalizedTransaction({
      transactionSignature: record.intendedTransactionSignature,
      minContextSlot: BigInt(record.minimumContextSlot),
      signal: input.signal,
    });
    if (finalizedTransaction === null) {
      renderRecovery(
        "The signature status is finalized, but the fixed Devnet endpoint did not return its transaction bytes. Check again later; this page will not publish a receipt from identifiers alone.",
        "neutral",
      );
      return false;
    }
    if (finalizedTransaction.signedWireSha256 !== record.signedWireSha256) {
      renderRecovery(
        "The finalized transaction bytes do not match the wallet-approved recovery digest. This page will not publish or clear a receipt.",
        "mismatch",
      );
      return false;
    }
    const validatedProof = await decodeAndValidateSignedCreatorPaidProofWire(
      decodeBase64(finalizedTransaction.transactionBase64),
      plan,
    );
    if (validatedProof.transactionSignature !== record.intendedTransactionSignature) {
      renderRecovery(
        "The finalized transaction signature does not match the saved recovery record. This page will not publish or clear a receipt.",
        "mismatch",
      );
      return false;
    }
    const receipt = createAtomicCreatorPaidReceipt({
      request: input.request,
      plan,
      validatedProof,
      receiptWrittenAt: new Date().toISOString(),
    });
    const verification = await verifyShareableReceiptOnDevnet(receipt, {
      signal: input.signal,
    });
    if (verification.status === "valid") {
      showConfirmed(receipt, record);
      return true;
    }
    if (verification.status === "invalid") {
      renderRecovery(
        "The transaction is finalized, but the current SAS account graph does not match every expected proof field. This page will not publish a receipt.",
        "mismatch",
      );
      return false;
    }
    renderRecovery(
      "The transaction is finalized, but the independent SAS account check is unavailable right now. Check again later; this page will never resubmit it.",
      "neutral",
    );
    return false;
  };

  const checkRecovery = async (
    record: DevnetIssuerRecoveryRecordV1,
    attempts: number,
  ): Promise<void> => {
    await rpc.assertGenesis({ signal: input.signal });
    const minimumContextSlot = BigInt(record.minimumContextSlot);
    let finalObservation:
      | Awaited<ReturnType<DevnetIssuerRpc["getSignatureStatus"]>>
      | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      ensureNotDisposed();
      const observation = await rpc.getSignatureStatus({
        transactionSignature: record.intendedTransactionSignature,
        minContextSlot: minimumContextSlot,
        signal: input.signal,
      });
      finalObservation = observation;
      if (
        observation.found &&
        observation.successful &&
        observation.confirmationStatus === "finalized"
      ) {
        await finalizeRecovery(record);
        return;
      }
      if (attempt + 1 < attempts) {
        renderRecovery(
          "The transaction is submitted and still settling on Devnet. Waiting for finality without broadcasting again…",
          "working",
          false,
        );
        await abortableDelay(FINALITY_POLL_MILLISECONDS, input.signal);
      }
    }

    if (
      finalObservation?.found === true &&
      finalObservation.confirmationStatus !== "finalized"
    ) {
      renderRecovery(
        finalObservation.successful
          ? "Devnet has recorded this transaction, but it is not finalized yet. The saved recovery remains status-only and will never broadcast it again."
          : "Devnet currently reports an unsuccessful transaction, but that observation is not finalized. Keep the recovery record and check again later.",
        "neutral",
      );
      return;
    }

    const blockhashValidity = await rpc.isBlockhashValid({
      recentBlockhash: record.recentBlockhash,
      minContextSlot:
        finalObservation?.transactionSlot !== undefined &&
        finalObservation.transactionSlot > minimumContextSlot
          ? finalObservation.transactionSlot
          : minimumContextSlot,
      signal: input.signal,
    });
    if (!blockhashValidity.value) {
      const accountRead = await rpc.getMultipleAccounts({
        addresses: [
          record.credentialAddress,
          record.schemaAddress,
          record.attestationAddress,
        ],
        commitment: "finalized",
        minContextSlot: blockhashValidity.contextSlot,
        signal: input.signal,
      });
      if (accountRead.accounts.every((accountValue) => accountValue === null)) {
        recoveryCanClear = true;
        renderRecovery(
          finalObservation?.found === true
            ? "Finalized Devnet reports this transaction as failed. Its recent blockhash is no longer valid and every intended account is absent at a context at least that new, so it is safe to clear this attempt and prepare again."
            : "The signature is absent from history, its recent blockhash is no longer valid at finalized commitment, and every intended account is absent at a context at least that new. It is safe to clear this attempt and prepare again.",
          "neutral",
        );
        return;
      }
      renderRecovery(
        "One or more intended accounts exist at finalized commitment. This page will not clear or resubmit the attempt automatically.",
        "mismatch",
      );
      return;
    }
    renderRecovery(
      finalObservation?.found === true
        ? "Devnet finalized this transaction as failed, but its recent blockhash remains valid at finalized commitment. Keep the saved record and check again later."
        : "Devnet has not found this signature and its recent blockhash remains valid at finalized commitment. The saved recovery will check status only and never submit again.",
      "neutral",
    );
  };

  const startRecoveryCheck = async (): Promise<void> => {
    if (busy || recovery === undefined) return;
    const record = recovery;
    busy = true;
    recoveryCanClear = false;
    renderRecovery(
      "Checking the fixed Solana Devnet endpoint for this exact signature…",
      "working",
      false,
    );
    try {
      await checkRecovery(record, 1);
    } catch (error: unknown) {
      if (!input.signal.aborted) {
        renderRecovery(
          safeMessage(
            error,
            "Devnet status is unavailable. Nothing was submitted again.",
          ),
          "neutral",
        );
      }
    } finally {
      busy = false;
    }
  };

  const signAndSubmit = async (): Promise<void> => {
    if (busy || quoteNeedsRefresh || quote === undefined || recovery !== undefined) return;
    const activeQuote = quote;
    const snapshot = walletSnapshot;
    if (
      snapshot?.status !== "connected" ||
      snapshot.wallet === null ||
      snapshot.account === null ||
      snapshot.account.address !== activeQuote.plan.creatorAddress
    ) {
      quote = undefined;
      renderWallet();
      showFailure(undefined, "The selected wallet changed. Prepare again.");
      return;
    }
    busy = true;
    clearView();
    setResult(
      "Rechecking the exact plan before asking the wallet for one signature…",
      "working",
    );
    try {
      await rpc.assertGenesis({ signal: input.signal });
      const [currentBlockHeight, accounts, balance, simulation] =
        await Promise.all([
          rpc.getBlockHeight({
            commitment: "confirmed",
            minContextSlot: activeQuote.plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
          rpc.getMultipleAccounts({
            addresses: [
              activeQuote.plan.credentialAddress,
              activeQuote.plan.schemaAddress,
              activeQuote.plan.attestationAddress,
            ],
            commitment: "confirmed",
            minContextSlot: activeQuote.plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
          rpc.getBalance({
            accountAddress: activeQuote.plan.creatorAddress,
            minContextSlot: activeQuote.plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
          rpc.simulateExactTransaction({
            transactionBase64: activeQuote.plan.unsignedTransactionBase64,
            minContextSlot: activeQuote.plan.confirmedContext.observedSlot,
            signal: input.signal,
          }),
        ]);
      if (
        activeQuote.plan.lifetimeConstraint.lastValidBlockHeight -
          currentBlockHeight <
        MINIMUM_SIGNING_BLOCKS_REMAINING
      ) {
        quoteNeedsRefresh = true;
        throw new Error(
          "This transaction's signing window has expired or is nearly over. Nothing was signed or submitted. Refresh the transaction, then review the updated cost and expiry before approving.",
        );
      }
      if (accounts.accounts.some((accountValue) => accountValue !== null)) {
        throw new Error(
          "A deterministic proof account appeared after review. The transaction was not signed.",
        );
      }
      if (balance.value < activeQuote.totalLamports) {
        throw new Error(
          "The selected account no longer has enough Devnet SOL for the reviewed maximum cost.",
        );
      }
      if (!simulation.succeeded) {
        throw new Error(
          "The exact reviewed transaction no longer passes Devnet simulation.",
        );
      }
      ensureNotDisposed();
      if (
        walletSnapshot?.status !== "connected" ||
        walletSnapshot.account?.address !== activeQuote.plan.creatorAddress
      ) {
        throw new Error("The wallet changed before signing.");
      }

      setResult(
        "Approve the one creator-paid Devnet transaction in your wallet. Velorn will reject any changed bytes before sending.",
        "working",
      );
      const signedWire = await signDevnetLegacyTransaction({
        wallet: snapshot.wallet,
        account: snapshot.account,
        unsignedTransaction: activeQuote.unsignedTransaction,
        validateExactSignedTransaction: async ({ signedTransaction }) => {
          await decodeAndValidateSignedCreatorPaidProofWire(
            signedTransaction,
            activeQuote.plan,
          );
        },
      });
      const validated = await decodeAndValidateSignedCreatorPaidProofWire(
        signedWire,
        activeQuote.plan,
      );
      ensureNotDisposed();

      const savedResult = await recoveryStore.save({
        requestId: input.request.requestId,
        requestHash: activeQuote.plan.canonicalRequestSha256,
        creatorAuthority: activeQuote.plan.creatorAddress,
        credentialName: activeQuote.plan.credentialName,
        credentialAddress: activeQuote.plan.credentialAddress,
        schemaAddress: activeQuote.plan.schemaAddress,
        subjectNonce: activeQuote.plan.subjectNonce,
        attestationAddress: activeQuote.plan.attestationAddress,
        intendedTransactionSignature: validated.transactionSignature,
        signedWireSha256: sha256HexPortable(signedWire),
        recentBlockhash: activeQuote.plan.lifetimeConstraint.blockhash,
        observedBlockHeight:
          activeQuote.plan.confirmedContext.observedBlockHeight.toString(),
        lastValidBlockHeight:
          activeQuote.plan.lifetimeConstraint.lastValidBlockHeight.toString(),
        minimumContextSlot:
          activeQuote.plan.confirmedContext.observedSlot.toString(),
        expiryUnixSeconds: activeQuote.plan.expiryUnixSeconds.toString(),
      });
      recovery = savedResult.record;
      quote = undefined;
      if (!savedResult.inserted) {
        renderRecovery(
          savedResult.matchesInput
            ? "Another tab already reserved this exact wallet-approved attempt. This tab will only check its status and will not send it again."
            : "A different wallet-approved attempt already owns this exact request binding. This tab will only check that saved attempt and will not send either transaction.",
          "neutral",
        );
        return;
      }
      renderRecovery(
        "The wallet-approved signature is saved for status-only recovery. Submitting these exact bytes to Devnet once…",
        "working",
        false,
      );
      try {
        await rpc.sendExactSignedWireOnce({
          transactionBase64: validated.signedTransactionBase64,
          expectedSignature: validated.transactionSignature,
          minimumContextSlot: activeQuote.plan.confirmedContext.observedSlot,
          signal: input.signal,
        });
      } catch (error: unknown) {
        renderRecovery(
          `${safeMessage(error, "The send response was uncertain.")} Check status; this page will not broadcast these bytes again.`,
          "neutral",
        );
        return;
      }
      await checkRecovery(savedResult.record, AUTOMATIC_FINALITY_CHECKS);
    } catch (error: unknown) {
      if (recovery !== undefined) {
        renderRecovery(
          `${safeMessage(error, "Finality could not be checked.")} The status-only recovery record remains available.`,
          "neutral",
        );
      } else {
        const message = safeMessage(
          error,
          "The wallet transaction was not signed or submitted.",
        );
        if (quote !== undefined) {
          renderReview(message);
        } else {
          // A Wallet Standard change event can invalidate the prepared quote
          // while signTransaction is pending. Release the busy guard before
          // returning to the live wallet state so the UI cannot dead-end.
          busy = false;
          renderWallet();
          setResult(message, "mismatch");
        }
      }
    } finally {
      busy = false;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopConnection?.();
    connection?.dispose();
    stopConnection = undefined;
    connection = undefined;
    quote = undefined;
  };
  input.signal.addEventListener("abort", dispose, { once: true });

  const bootstrap = async (): Promise<void> => {
    setResult(
      "Checking this browser for a request-scoped status recovery record…",
      "working",
    );
    try {
      recovery =
        (await recoveryStore.load({
          requestId: input.request.requestId,
          requestHash,
        })) ?? undefined;
    } catch (error: unknown) {
      clearView();
      showFailure(
        error,
        "Safe same-origin recovery coordination is unavailable. Wallet issuance is disabled in this browser.",
      );
      return;
    }
    if (disposed || input.signal.aborted) return;
    if (recovery !== undefined) {
      renderRecovery(
        "A wallet-approved attempt for this exact request is saved on this device. Check its Devnet status; it will never be signed or submitted again.",
      );
      return;
    }
    setResult(
      "Exact bytes matched. Connect a compatible Devnet wallet when you are ready.",
      "match",
    );
    ensureConnection();
  };
  void bootstrap();
}
