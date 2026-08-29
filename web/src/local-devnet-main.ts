import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
  type CreatorProvenanceManifestV1,
  type ProvenanceRequestV1,
  type ShareableProvenanceReceiptV1,
} from "../../src/contracts.js";
import { hashBlobSha256, type HashBlobOptions } from "./browser-hash.js";
import { signDevnetLegacyTransaction } from "./devnet-wallet-signing.js";
import { createExactWalletReturnedWireValidator } from "./exact-wallet-wire.js";
import {
  createLocalDevnetHarnessClient,
  type LocalDevnetFetch,
  type LocalDevnetHarnessClient,
} from "./local-devnet-client.js";
import {
  DevnetWalletConnection,
  type DevnetWalletSnapshot,
} from "./wallet-standard.js";
import { encodeVerifyFragment } from "./fragment-contract.js";

export const LOCAL_DEVNET_UI_ORIGIN = "http://127.0.0.1:4173" as const;
export const LOCAL_PUBLIC_VERIFIER_ORIGIN = "http://127.0.0.1:5173" as const;

type EnrollmentPlan = Awaited<
  ReturnType<LocalDevnetHarnessClient["planEnrollment"]>
>;
type EnrollmentStatus = Awaited<
  ReturnType<LocalDevnetHarnessClient["getEnrollmentStatus"]>
>;
type ConnectResult = Awaited<
  ReturnType<LocalDevnetHarnessClient["connectCreator"]>
>;
type AttestationPlan = Awaited<
  ReturnType<LocalDevnetHarnessClient["beginAttestation"]>
>;
type AttestationStatus = Awaited<
  ReturnType<LocalDevnetHarnessClient["getAttestationStatus"]>
>;
type ClientSession = Awaited<
  ReturnType<LocalDevnetHarnessClient["startSession"]>
>;

type UiPhase =
  | "idle"
  | "starting"
  | "wallet"
  | "binding"
  | "enrollment-choice"
  | "enrollment-planning"
  | "enrollment-review"
  | "enrollment-reused"
  | "enrollment-signing"
  | "enrollment-submitting"
  | "enrollment-uncertain"
  | "file"
  | "hashing"
  | "request-review"
  | "attestation-planning"
  | "attestation-review"
  | "attestation-signing"
  | "attestation-submitting"
  | "attestation-uncertain"
  | "confirmed";

export interface LocalDevnetTestRequestInput {
  readonly requestId: string;
  readonly mediaSha256: string;
  readonly byteLength: number;
  readonly mimeType?: string;
  readonly declaredAt: string;
}

export interface LocalDevnetUiDependencies {
  readonly createClient: () => LocalDevnetHarnessClient;
  readonly createWalletConnection: () => DevnetWalletConnection;
  readonly hashBlob: (
    blob: Blob,
    options?: HashBlobOptions,
  ) => Promise<string>;
  readonly signTransaction: typeof signDevnetLegacyTransaction;
  readonly now: () => Date;
  readonly randomBytes: (byteLength: number) => Uint8Array;
}

const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u;

export function isExactLocalDevnetOrigin(origin: string): boolean {
  return origin === LOCAL_DEVNET_UI_ORIGIN;
}

export function createLocalDevnetRequestId(
  timestampMilliseconds: number,
  entropy: Uint8Array,
): string {
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    timestampMilliseconds <= 0 ||
    !(entropy instanceof Uint8Array) ||
    entropy.byteLength !== 12
  ) {
    throw new TypeError("Devnet request identity input is invalid");
  }
  const suffix = [...entropy]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `request_devnet_${timestampMilliseconds}_${suffix}`;
}

/**
 * Creates a new request from the bytes the user selected for this run. It is
 * intentionally separate from the deterministic offline preview fixture.
 */
export function createLocalDevnetTestRequest(
  input: LocalDevnetTestRequestInput,
): ProvenanceRequestV1 {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
    throw new TypeError("Selected media size is invalid");
  }
  const media: CreatorProvenanceManifestV1["media"] = {
    byteLength: String(input.byteLength),
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
  };
  const manifest: CreatorProvenanceManifestV1 = {
    contract: PROVENANCE_MANIFEST_CONTRACT,
    version: CONTRACT_VERSION,
    statement: CREATOR_RELATIONSHIP_STATEMENT,
    declaredAt: input.declaredAt,
    media,
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "issue",
    },
  };
  return createProvenanceRequest({
    requestId: input.requestId,
    mediaSha256: input.mediaSha256,
    manifest,
  });
}

export function devnetAccountExplorerUrl(value: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(value)}?cluster=devnet`;
}

export function devnetTransactionExplorerUrl(value: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(value)}?cluster=devnet`;
}

export function localPublicVerifierUrl(
  receipt: ShareableProvenanceReceiptV1,
): string {
  return `${LOCAL_PUBLIC_VERIFIER_ORIGIN}/${encodeVerifyFragment(receipt)}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { readonly className?: string; readonly text?: string } = {},
): HTMLElementTagNameMap[K] {
  const output = document.createElement(tag);
  if (options.className) output.className = options.className;
  if (options.text !== undefined) output.textContent = options.text;
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function shortAddress(value: string): string {
  return value.length <= 20
    ? value
    : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1_024;
  let unit = units[0] ?? "KB";
  for (let index = 1; index < units.length && size >= 1_024; index += 1) {
    size /= 1_024;
    unit = units[index] ?? unit;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function friendlyExpiry(value: string): string {
  const milliseconds = Number(BigInt(value) * 1_000n);
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? value : `${date.toLocaleString()} (${value})`;
}

function dataRow(label: string, value: string): HTMLElement {
  const row = element("div", { className: "definition-row" });
  row.append(element("dt", { text: label }), element("dd", { text: value }));
  return row;
}

function externalRow(label: string, visible: string, href: string): HTMLElement {
  const row = element("div", { className: "definition-row" });
  const value = element("dd");
  const link = element("a", { className: "evidence-link", text: visible });
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  value.append(link);
  row.append(element("dt", { text: label }), value);
  return row;
}

function dataPanel(
  title: string,
  rows: readonly HTMLElement[],
  copy?: string,
): HTMLElement {
  const panel = element("section", { className: "panel" });
  panel.append(element("h2", { text: title }));
  if (copy) panel.append(element("p", { className: "muted", text: copy }));
  const list = element("dl", { className: "definition-list" });
  list.append(...rows);
  panel.append(list);
  return panel;
}

class LocalDevnetUi {
  readonly #root: HTMLDivElement;
  readonly #dependencies: LocalDevnetUiDependencies;
  #phase: UiPhase = "idle";
  #busy = false;
  #disposed = false;
  #message: string | undefined;
  #client: LocalDevnetHarnessClient | undefined;
  #session: ClientSession | undefined;
  #walletConnection: DevnetWalletConnection | undefined;
  #walletConnectAttempt = 0;
  #stopWalletSubscription: (() => void) | undefined;
  #walletSnapshot: DevnetWalletSnapshot | undefined;
  #connectResult: ConnectResult | undefined;
  #enrollmentPlan: EnrollmentPlan | undefined;
  #enrollmentStatus: EnrollmentStatus | undefined;
  #hashController: AbortController | undefined;
  #hashRatio = 0;
  #request: ProvenanceRequestV1 | undefined;
  #attestationPlan: AttestationPlan | undefined;
  #attestationStatus: AttestationStatus | undefined;

  constructor(
    root: HTMLDivElement,
    dependencies: LocalDevnetUiDependencies,
  ) {
    this.#root = root;
    this.#dependencies = dependencies;
    this.#render();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#hashController?.abort();
    this.#stopWalletSubscription?.();
    this.#walletConnection?.dispose();
  }

  async #exclusive(task: () => Promise<void>): Promise<void> {
    if (this.#busy || this.#disposed) return;
    this.#busy = true;
    this.#message = undefined;
    this.#render();
    try {
      await task();
    } finally {
      this.#busy = false;
      if (!this.#disposed) this.#render();
    }
  }

  #button(
    label: string,
    action: () => void | Promise<void>,
    options: {
      readonly secondary?: boolean;
      readonly disabled?: boolean;
      readonly allowWhileBusy?: boolean;
    } = {},
  ): HTMLButtonElement {
    const button = element("button", {
      className: options.secondary
        ? "secondary-button local-action"
        : "wallet-button local-action",
      text: label,
    });
    button.type = "button";
    button.disabled =
      (this.#busy && options.allowWhileBusy !== true) ||
      options.disabled === true;
    button.addEventListener("click", () => {
      if (!button.disabled) void action();
    });
    return button;
  }

  #currentBoundWallet() {
    const snapshot = this.#walletConnection?.getSnapshot();
    const creator = this.#connectResult?.creatorAuthority;
    if (
      snapshot?.status !== "connected" ||
      snapshot.wallet === null ||
      snapshot.account === null ||
      creator === undefined ||
      snapshot.account.address !== creator
    ) {
      return undefined;
    }
    return { wallet: snapshot.wallet, account: snapshot.account };
  }

  #start(): Promise<void> {
    return this.#exclusive(async () => {
      this.#phase = "starting";
      this.#render();
      try {
        const client = this.#dependencies.createClient();
        const session = await client.startSession();
        if (this.#disposed) return;
        const connection = this.#dependencies.createWalletConnection();
        this.#client = client;
        this.#session = session;
        this.#walletConnection = connection;
        this.#walletSnapshot = connection.getSnapshot();
        this.#stopWalletSubscription = connection.subscribe((snapshot) => {
          this.#walletSnapshot = snapshot;
          if (!this.#disposed) this.#render();
        });
        this.#phase = "wallet";
      } catch {
        this.#phase = "idle";
        this.#message = "The isolated local Devnet session could not start.";
      }
    });
  }

  #connectWallet(wallet: DevnetWalletSnapshot["wallet"]): Promise<void> {
    if (
      this.#busy ||
      this.#disposed ||
      wallet === null ||
      this.#walletConnection === undefined
    ) {
      return Promise.resolve();
    }
    const connection = this.#walletConnection;
    const attempt = ++this.#walletConnectAttempt;
    this.#busy = true;
    this.#message = undefined;
    this.#render();
    return connection
      .connect(wallet)
      .then(() => undefined)
      .catch(() => {
        if (attempt === this.#walletConnectAttempt) {
          this.#message =
            "The wallet connection was cancelled or could not finish.";
        }
      })
      .finally(() => {
        if (attempt !== this.#walletConnectAttempt) return;
        this.#busy = false;
        if (!this.#disposed) this.#render();
      });
  }

  #selectWalletAccount(address: string): void {
    if (this.#busy || this.#walletConnection === undefined) return;
    try {
      this.#walletConnection.selectAccount(address);
    } catch {
      this.#message = "That Devnet account could not be selected.";
      this.#render();
    }
  }

  #clearLocalWalletSelection(): void {
    const connection = this.#walletConnection;
    if (connection === undefined || this.#disposed) return;
    // disconnect() clears this controller synchronously before it invokes the
    // extension's optional cleanup hook. A stale/hung extension response must
    // not restore the abandoned connection or trap this local page.
    this.#walletConnectAttempt += 1;
    this.#busy = false;
    void connection.disconnect().catch(() => undefined);
    this.#message =
      "This page cleared its local wallet selection. The extension may retain site authorization; manage that separately inside the wallet.";
    this.#render();
  }

  #renderBoundWalletRecovery(): HTMLElement | undefined {
    if (this.#currentBoundWallet() !== undefined) return undefined;

    const creator = this.#connectResult?.creatorAuthority;
    const snapshot = this.#walletConnection?.getSnapshot();
    const panel = element("section", {
      className: "panel local-wallet-recovery",
    });
    panel.append(
      element("h3", { text: "Reconnect the same creator account" }),
      element("p", {
        className: "muted",
        text: "The prepared transaction is unchanged. Reconnect only the creator address shown in this review; the page will not rebuild or replace it.",
      }),
    );

    if (creator === undefined || snapshot === undefined) {
      panel.append(
        element("p", {
          className: "local-caution",
          text: "The original creator binding is unavailable. Restart this local test without signing.",
        }),
      );
      return panel;
    }

    if (snapshot.status === "connecting") {
      panel.append(
        element("p", {
          className: "muted",
          text: `Waiting for ${snapshot.wallet?.name ?? "wallet"} authorization…`,
        }),
        this.#button(
          "Cancel local reconnection",
          () => this.#clearLocalWalletSelection(),
          { secondary: true, allowWhileBusy: true },
        ),
      );
      return panel;
    }

    if (snapshot.status === "selecting-account") {
      const exactAccount = snapshot.accounts.find(
        (account) => account.address === creator,
      );
      if (exactAccount === undefined) {
        panel.append(
          element("p", {
            className: "local-caution",
            text: "This wallet did not return the originally bound creator account.",
          }),
        );
      } else {
        panel.append(
          this.#button(
            `Use ${shortAddress(exactAccount.address)}`,
            () => this.#selectWalletAccount(exactAccount.address),
          ),
        );
      }
      panel.append(
        this.#button(
          "Clear local wallet selection",
          () => this.#clearLocalWalletSelection(),
          { secondary: true },
        ),
      );
      return panel;
    }

    if (snapshot.status === "connected") {
      panel.append(
        element("p", {
          className: "local-caution",
          text: "The connected account is not the creator bound to this exact transaction.",
        }),
        this.#button(
          "Clear local wallet selection",
          () => this.#clearLocalWalletSelection(),
          { secondary: true },
        ),
      );
      return panel;
    }

    if (snapshot.wallets.length === 0) {
      panel.append(
        element("p", {
          className: "muted",
          text: "No compatible Devnet Wallet Standard extension is detected.",
        }),
      );
      return panel;
    }

    const actions = element("div", { className: "wallet-actions" });
    for (const wallet of snapshot.wallets) {
      actions.append(
        this.#button(
          `Reconnect ${wallet.name}`,
          () => this.#connectWallet(wallet),
        ),
      );
    }
    panel.append(actions);
    return panel;
  }

  #bindCreator(): Promise<void> {
    return this.#exclusive(async () => {
      const client = this.#client;
      const snapshot = this.#walletConnection?.getSnapshot();
      if (client === undefined || snapshot?.account === null || snapshot?.account === undefined) {
        this.#message = "Connect one Devnet-compatible account first.";
        return;
      }
      this.#phase = "binding";
      this.#render();
      try {
        this.#connectResult = await client.connectCreator(
          snapshot.account.address,
        );
        this.#phase = "enrollment-choice";
      } catch {
        this.#phase = "wallet";
        this.#message = "The local service could not verify that creator account on Devnet.";
      }
    });
  }

  #planEnrollment(): Promise<void> {
    return this.#exclusive(async () => {
      const client = this.#client;
      if (client === undefined) return;
      this.#phase = "enrollment-planning";
      this.#render();
      try {
        const plan = await client.planEnrollment();
        this.#enrollmentPlan = plan;
        this.#phase = plan.kind === "reused"
          ? "enrollment-reused"
          : "enrollment-review";
      } catch {
        this.#phase = "enrollment-choice";
        this.#message = "The exact creator setup could not be prepared.";
      }
    });
  }

  #signEnrollment(): Promise<void> {
    return this.#exclusive(async () => {
      const plan = this.#enrollmentPlan;
      const client = this.#client;
      const selected = this.#currentBoundWallet();
      if (plan?.kind !== "transaction" || client === undefined || selected === undefined) {
        this.#message = "Reconnect the same creator account before signing.";
        return;
      }
      const unsigned = decodeBase64(plan.unsignedTransactionBase64);
      this.#phase = "enrollment-signing";
      this.#render();
      let signed: Uint8Array | undefined;
      try {
        signed = await this.#dependencies.signTransaction({
          wallet: selected.wallet,
          account: selected.account,
          unsignedTransaction: unsigned,
          validateExactSignedTransaction:
            createExactWalletReturnedWireValidator(),
        });
      } catch {
        this.#phase = "enrollment-review";
        this.#message = "No creator setup was submitted. The wallet did not complete the exact transaction. Its recent Devnet blockhash may have expired while approval was open; restart this local checkpoint to prepare fresh bytes.";
        unsigned.fill(0);
        return;
      }
      if (this.#disposed) {
        signed.fill(0);
        unsigned.fill(0);
        return;
      }
      this.#enrollmentPlan = undefined;
      this.#phase = "enrollment-submitting";
      this.#render();
      let signedBase64 = "";
      try {
        signedBase64 = encodeBase64(signed);
        const result = await client.completeEnrollment(signedBase64);
        this.#enrollmentStatus = result;
        this.#phase = "file";
      } catch {
        this.#phase = "enrollment-uncertain";
        this.#message = "The response was uncertain. This page will not sign or submit again; use the status check below.";
      } finally {
        signedBase64 = "";
        signed.fill(0);
        unsigned.fill(0);
      }
    });
  }

  #checkEnrollmentStatus(): Promise<void> {
    return this.#exclusive(async () => {
      try {
        const status = await this.#client?.getEnrollmentStatus();
        if (status === undefined) return;
        this.#enrollmentStatus = status;
        this.#phase = status.state === "confirmed"
          ? "file"
          : "enrollment-uncertain";
      } catch {
        this.#message = "Status is still unavailable. Nothing was re-signed or resubmitted.";
      }
    });
  }

  #useReusedEnrollment(): void {
    if (this.#busy) return;
    this.#enrollmentPlan = undefined;
    this.#phase = "file";
    this.#render();
  }

  async #hashFile(file: File): Promise<void> {
    if (this.#busy || this.#disposed) return;
    this.#busy = true;
    this.#message = undefined;
    this.#phase = "hashing";
    this.#hashRatio = 0;
    const controller = new AbortController();
    this.#hashController = controller;
    this.#render();
    try {
      const mediaSha256 = await this.#dependencies.hashBlob(file, {
        signal: controller.signal,
        onProgress: ({ ratio }) => {
          if (this.#hashController !== controller || this.#disposed) return;
          this.#hashRatio = ratio;
          this.#render();
        },
      });
      if (this.#disposed || this.#hashController !== controller) return;
      const now = this.#dependencies.now();
      const mimeType = MIME_PATTERN.test(file.type) ? file.type : undefined;
      this.#request = createLocalDevnetTestRequest({
        requestId: createLocalDevnetRequestId(
          now.valueOf(),
          this.#dependencies.randomBytes(12),
        ),
        mediaSha256,
        byteLength: file.size,
        ...(mimeType === undefined ? {} : { mimeType }),
        declaredAt: now.toISOString(),
      });
      this.#phase = "request-review";
    } catch (error: unknown) {
      this.#phase = "file";
      this.#message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Local hashing was cancelled."
          : "The selected file could not be hashed locally.";
    } finally {
      if (this.#hashController === controller) this.#hashController = undefined;
      this.#busy = false;
      if (!this.#disposed) this.#render();
    }
  }

  #cancelHash(): void {
    this.#hashController?.abort();
  }

  #prepareAttestation(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#client === undefined || this.#request === undefined) return;
      this.#phase = "attestation-planning";
      this.#render();
      try {
        this.#attestationPlan = await this.#client.beginAttestation(
          this.#request,
        );
        this.#phase = "attestation-review";
      } catch {
        this.#phase = "request-review";
        this.#message = "The sponsored proof transaction could not be prepared.";
      }
    });
  }

  #signAttestation(): Promise<void> {
    return this.#exclusive(async () => {
      const plan = this.#attestationPlan;
      const client = this.#client;
      const selected = this.#currentBoundWallet();
      if (plan === undefined || client === undefined || selected === undefined) {
        this.#message = "Reconnect the same creator account before signing.";
        return;
      }
      const unsigned = decodeBase64(plan.unsignedTransactionBase64);
      this.#phase = "attestation-signing";
      this.#render();
      let signed: Uint8Array | undefined;
      try {
        signed = await this.#dependencies.signTransaction({
          wallet: selected.wallet,
          account: selected.account,
          unsignedTransaction: unsigned,
          validateExactSignedTransaction:
            createExactWalletReturnedWireValidator(plan.messageSha256),
        });
      } catch {
        this.#phase = "attestation-review";
        this.#message = "No proof was submitted. The wallet did not complete the exact transaction. Its recent Devnet blockhash may have expired while approval was open; restart this local checkpoint to prepare fresh bytes.";
        unsigned.fill(0);
        return;
      }
      if (this.#disposed) {
        signed.fill(0);
        unsigned.fill(0);
        return;
      }
      this.#attestationPlan = undefined;
      this.#phase = "attestation-submitting";
      this.#render();
      let signedBase64 = "";
      try {
        signedBase64 = encodeBase64(signed);
        const status = await client.completeAttestation(signedBase64);
        this.#attestationStatus = status;
        this.#phase = status.state === "confirmed"
          ? "confirmed"
          : "attestation-uncertain";
      } catch {
        this.#phase = "attestation-uncertain";
        this.#message = "The response was uncertain. This page will not sign or submit again; use the status check below.";
      } finally {
        signedBase64 = "";
        signed.fill(0);
        unsigned.fill(0);
      }
    });
  }

  #checkAttestationStatus(): Promise<void> {
    return this.#exclusive(async () => {
      try {
        const status = await this.#client?.getAttestationStatus();
        if (status === undefined) return;
        this.#attestationStatus = status;
        this.#phase = status.state === "confirmed"
          ? "confirmed"
          : "attestation-uncertain";
      } catch {
        this.#message = "Status is still unavailable. Nothing was re-signed or resubmitted.";
      }
    });
  }

  #progressStep(): number {
    if (this.#phase === "confirmed") return 4;
    if (
      this.#phase === "file" ||
      this.#phase === "hashing" ||
      this.#phase === "request-review" ||
      this.#phase.startsWith("attestation-")
    ) return 3;
    if (this.#phase.startsWith("enrollment-")) return 2;
    return 1;
  }

  #shell(): { readonly shell: HTMLElement; readonly content: HTMLElement } {
    const shell = element("div", { className: "shell local-devnet-shell" });
    const header = element("header", { className: "site-header" });
    const brand = element("div", { className: "brand-row" });
    brand.append(
      element("span", { className: "brand-mark", text: "V" }),
      element("div", { className: "local-brand-copy" }),
    );
    const copy = brand.lastElementChild as HTMLElement;
    copy.append(
      element("strong", { text: "Velorn" }),
      element("span", { className: "brand-subtitle", text: "Creator Provenance" }),
    );
    header.append(
      brand,
      element("span", { className: "network-pill", text: "Solana Devnet · local test" }),
    );
    const content = element("main", { className: "content" });
    const footer = element("footer", { className: "site-footer" });
    footer.append(element("span", { text: "Isolated loopback checkpoint · Public preview unchanged" }));
    shell.append(header, content, footer);
    return { shell, content };
  }

  #render(): void {
    if (this.#disposed) return;
    const { shell, content } = this.#shell();
    const hero = element("section", { className: "hero local-hero" });
    hero.append(
      element("span", { className: "eyebrow", text: "Guided local checkpoint" }),
      element("h1", { text: "Create one exact provenance proof on Solana Devnet." }),
      element("p", {
        className: "hero-copy",
        text: "Every network or wallet action waits for you. This test never uses Mainnet, creates a token, uploads media, or claims to prove copyright.",
      }),
    );
    content.append(hero, this.#renderBoundaries(), this.#renderProgress());
    if (this.#message) {
      const notice = element("aside", { className: "local-message" });
      notice.setAttribute("role", "status");
      notice.append(element("strong", { text: "Checkpoint update" }), element("p", { text: this.#message }));
      content.append(notice);
    }
    content.append(this.#renderPhase());
    this.#root.replaceChildren(shell);
  }

  #renderBoundaries(): HTMLElement {
    const notice = element("aside", { className: "privacy-notice local-boundary" });
    notice.append(
      element("span", { className: "privacy-icon", text: "✓" }),
      element("div"),
    );
    const copy = notice.lastElementChild as HTMLElement;
    copy.append(
      element("strong", { text: "Devnet only, opt-in, and local media" }),
      element("p", {
        text: "The selected file is hashed in this browser and is never uploaded. Enrollment is creator-paid with valueless Devnet SOL; the later proof is sponsor-paid. Only reviewed public hashes and metadata are committed.",
      }),
    );
    return notice;
  }

  #renderProgress(): HTMLElement {
    const current = this.#progressStep();
    const list = element("ol", { className: "local-progress" });
    for (const [index, label] of [
      "Connect",
      "Creator setup",
      "Review proof",
      "Confirmed",
    ].entries()) {
      const item = element("li", {
        className: index + 1 === current ? "current" : index + 1 < current ? "done" : "",
      });
      item.append(
        element("span", { text: String(index + 1).padStart(2, "0") }),
        element("strong", { text: label }),
      );
      list.append(item);
    }
    return list;
  }

  #renderPhase(): HTMLElement {
    switch (this.#phase) {
      case "idle": return this.#renderIdle();
      case "starting": return this.#working("Starting the isolated session…", "No wallet request has been made.");
      case "wallet":
      case "binding": return this.#renderWallet();
      case "enrollment-choice": return this.#renderEnrollmentChoice();
      case "enrollment-planning": return this.#working("Preparing creator setup…", "This is a read-only Devnet planning step.");
      case "enrollment-review": return this.#renderEnrollmentReview();
      case "enrollment-reused": return this.#renderReusedEnrollment();
      case "enrollment-signing": return this.#working("Waiting for your wallet…", "Nothing is sent unless the exact returned signature validates.");
      case "enrollment-submitting": return this.#working("Checking creator setup confirmation…", "Do not close or reload this page.");
      case "enrollment-uncertain": return this.#renderEnrollmentRecovery();
      case "file": return this.#renderFilePicker();
      case "hashing": return this.#renderHashing();
      case "request-review": return this.#renderRequestReview();
      case "attestation-planning": return this.#working("Preparing the sponsored proof…", "No signature or chain write occurs during this step.");
      case "attestation-review": return this.#renderAttestationReview();
      case "attestation-signing": return this.#working("Waiting for your wallet…", "The sponsor slot must remain untouched by the creator wallet.");
      case "attestation-submitting": return this.#working("Submitting and checking finality…", "The exact transaction is never rebuilt or sent twice.");
      case "attestation-uncertain": return this.#renderAttestationRecovery();
      case "confirmed": return this.#renderConfirmed();
    }
  }

  #working(title: string, copy: string): HTMLElement {
    const panel = element("section", { className: "panel local-working" });
    panel.append(element("span", { className: "local-spinner", text: "·" }), element("h2", { text: title }), element("p", { className: "muted", text: copy }));
    return panel;
  }

  #renderIdle(): HTMLElement {
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(
      element("span", { className: "status-badge", text: "Nothing started" }),
      element("h2", { text: "Start the local Devnet checkpoint" }),
      element("p", { className: "muted", text: "Starting creates a same-origin local session. It does not connect a wallet, request a signature, call Mainnet, or write to Solana." }),
      this.#button("Start local Devnet test", () => this.#start()),
    );
    return panel;
  }

  #renderWallet(): HTMLElement {
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("h2", { text: "Choose the creator account" }));
    const snapshot = this.#walletSnapshot;
    if (snapshot === undefined) {
      panel.append(element("p", { className: "muted", text: "Wallet discovery is starting." }));
      return panel;
    }
    if (snapshot.status === "connecting") {
      panel.append(
        element("p", { className: "muted", text: `Waiting for ${snapshot.wallet?.name ?? "wallet"} authorization…` }),
        this.#button(
          "Cancel local connection attempt",
          () => this.#clearLocalWalletSelection(),
          { secondary: true, allowWhileBusy: true },
        ),
      );
      return panel;
    }
    if (snapshot.status === "selecting-account") {
      panel.append(element("p", { className: "muted", text: "Choose the exact Devnet public account for this one local run." }));
      const actions = element("div", { className: "wallet-actions" });
      for (const account of snapshot.accounts) {
        actions.append(this.#button(`Use ${shortAddress(account.address)}`, () => this.#selectWalletAccount(account.address)));
      }
      actions.append(
        this.#button(
          "Clear local wallet selection",
          () => this.#clearLocalWalletSelection(),
          { secondary: true },
        ),
      );
      panel.append(actions);
      return panel;
    }
    if (snapshot.status === "connected" && snapshot.account && snapshot.wallet) {
      panel.append(
        element("p", { className: "muted", text: `${snapshot.wallet.name} authorized this public account locally. No signature has been requested.` }),
        dataPanel("Selected account", [dataRow("Creator address", snapshot.account.address)]),
        this.#button("Use this account for the Devnet test", () => this.#bindCreator()),
        this.#button(
          "Clear local wallet selection",
          () => this.#clearLocalWalletSelection(),
          { secondary: true },
        ),
      );
      return panel;
    }
    panel.append(element("p", { className: "muted", text: snapshot.wallets.length === 0 ? "No compatible Devnet Wallet Standard extension is detected." : "Choose a compatible wallet. Connection alone does not sign or spend." }));
    const actions = element("div", { className: "wallet-actions" });
    for (const wallet of snapshot.wallets) {
      actions.append(this.#button(`Connect ${wallet.name}`, () => this.#connectWallet(wallet)));
    }
    panel.append(actions);
    return panel;
  }

  #renderEnrollmentChoice(): HTMLElement {
    const result = this.#connectResult;
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(
      element("span", { className: "status-badge", text: result?.enrollmentState === "ready" ? "Setup found" : "One-time setup required" }),
      element("h2", { text: "Review the creator setup" }),
      element("p", { className: "muted", text: "This read-only step asks the fixed local service whether the exact Velorn credential and schema already exist, then prepares only the allowed setup if needed." }),
    );
    if (result) panel.append(dataPanel("Derived public accounts", [dataRow("Creator", result.creatorAuthority), dataRow("Credential", result.credentialAddress), dataRow("Schema", result.schemaAddress)]));
    panel.append(this.#button("Prepare creator setup review", () => this.#planEnrollment()));
    return panel;
  }

  #renderEnrollmentReview(): HTMLElement {
    const plan = this.#enrollmentPlan;
    const session = this.#session;
    if (plan?.kind !== "transaction" || session === undefined) return this.#working("Creator setup unavailable", "Restart the local harness before continuing.");
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(
      element("span", { className: "status-badge", text: "Signature review 1 of 2" }),
      element("h2", { text: "Create the Devnet creator identity" }),
      element("p", { className: "muted", text: "This exact transaction creates a Velorn credential and MEDIA-COMMITMENT schema through Solana Attestation Service. Your creator account signs and pays the Devnet network fee and rent-exempt account deposits. It uploads no media and transfers no token." }),
      dataPanel("Exact public setup", [
        dataRow("Network", "Solana Devnet"),
        dataRow("SAS program", session.sasProgramId),
        dataRow("Creator and fee payer", plan.creatorAuthority),
        dataRow("Credential address", plan.credentialAddress),
        dataRow("Schema address", plan.schemaAddress),
      ]),
      element("p", { className: "local-caution", text: "Make sure this account has Devnet SOL. Phantom will show the exact network fee and rent-exempt account deposits before you approve. Approve promptly after opening Phantom because the recent Devnet blockhash usually lasts only about 60–90 seconds." }),
    );
    const walletRecovery = this.#renderBoundWalletRecovery();
    if (walletRecovery !== undefined) panel.append(walletRecovery);
    panel.append(
      this.#button("Sign and create on Devnet", () => this.#signEnrollment(), {
        disabled: this.#currentBoundWallet() === undefined,
      }),
    );
    return panel;
  }

  #renderReusedEnrollment(): HTMLElement {
    const plan = this.#enrollmentPlan;
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("span", { className: "status-badge", text: "Already confirmed" }), element("h2", { text: "Creator setup is ready" }), element("p", { className: "muted", text: "The exact credential and schema from this local run are already confirmed. No enrollment signature or payment is needed again." }));
    if (plan) panel.append(dataPanel("Reused public accounts", [dataRow("Creator", plan.creatorAuthority), dataRow("Credential", plan.credentialAddress), dataRow("Schema", plan.schemaAddress)]));
    panel.append(this.#button("Continue to choose media", () => this.#useReusedEnrollment()));
    return panel;
  }

  #renderEnrollmentRecovery(): HTMLElement {
    const status = this.#enrollmentStatus;
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("span", { className: "status-badge", text: "Status only" }), element("h2", { text: "Check the creator setup—do not sign again" }), element("p", { className: "muted", text: `Current state: ${status?.state ?? "unknown"}. A status check can only inspect the retained plan; it cannot sign, rebuild, or resend it.` }));
    if (status?.transactionSignature && SIGNATURE_PATTERN.test(status.transactionSignature)) panel.append(dataPanel("Public transaction evidence", [externalRow("Enrollment transaction", status.transactionSignature, devnetTransactionExplorerUrl(status.transactionSignature))]));
    panel.append(this.#button("Check enrollment status", () => this.#checkEnrollmentStatus(), { secondary: true }));
    return panel;
  }

  #renderFilePicker(): HTMLElement {
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("span", { className: "status-badge", text: "Local file only" }), element("h2", { text: "Choose the media for this real Devnet test" }), element("p", { className: "muted", text: "The browser reads and hashes the selected bytes locally. The filename and media bytes are never sent; only the resulting hash, byte count, optional MIME type, and declaration time enter the public request." }));
    const picker = element("label", { className: "file-picker" });
    picker.append(element("span", { className: "file-picker-title", text: "Choose video or media" }), element("span", { className: "file-picker-copy", text: "Nothing is uploaded" }));
    const input = element("input");
    input.type = "file";
    input.accept = "video/*,audio/*,image/*,.mov";
    input.className = "visually-hidden";
    input.disabled = this.#busy;
    input.addEventListener("change", () => {
      const file = input.files?.item(0);
      if (file) void this.#hashFile(file);
    });
    picker.append(input);
    panel.append(picker);
    return panel;
  }

  #renderHashing(): HTMLElement {
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("h2", { text: "Hashing locally…" }), element("p", { className: "muted", text: `${Math.round(this.#hashRatio * 100)}% complete. No file bytes leave this browser.` }));
    const progress = element("progress", { className: "hash-progress" });
    progress.max = 1;
    progress.value = this.#hashRatio;
    panel.append(
      progress,
      this.#button("Cancel local hashing", () => this.#cancelHash(), {
        secondary: true,
        allowWhileBusy: true,
      }),
    );
    return panel;
  }

  #requestPanels(): HTMLElement[] {
    const request = this.#request;
    if (request === undefined) return [];
    const manifest = request.manifest;
    return [
      dataPanel("Complete public request", [
        dataRow("Request contract", request.contract),
        dataRow("Contract version", String(request.version)),
        dataRow("Request ID", request.requestId),
        dataRow("Network", request.network),
        dataRow("Media SHA-256", request.media.sha256),
        dataRow("Manifest contract", manifest.contract),
        dataRow("Manifest version", String(manifest.version)),
        dataRow("Creator statement", manifest.statement),
        dataRow("Declared at", manifest.declaredAt),
        dataRow("Media bytes", manifest.media.byteLength),
        dataRow("Declared MIME type", manifest.media.mimeType ?? "Not included"),
        dataRow("Lifecycle action", manifest.lifecycle.action),
        dataRow("Public profile", manifest.profile === undefined ? "Not included" : "Included"),
        dataRow("Manifest SHA-256", request.commitment.manifestSha256),
        dataRow("Statement type", request.commitment.statementType),
        dataRow("Commitment version", String(request.commitment.version)),
      ], "These are all fields in this request. It contains no filename, local path, prompt, private key, or media bytes."),
      this.#canonicalRequestDisclosure(request),
    ];
  }

  #canonicalRequestDisclosure(request: ProvenanceRequestV1): HTMLElement {
    const details = element("details", { className: "panel local-json" });
    details.append(element("summary", { text: "Inspect canonical public request JSON" }));
    const pre = element("pre");
    pre.textContent = serializeCanonicalProvenanceRequestJson(request);
    details.append(pre);
    return details;
  }

  #renderRequestReview(): HTMLElement {
    const wrapper = element("div", { className: "local-stack" });
    const lead = element("section", { className: "panel local-primary-panel" });
    lead.append(element("span", { className: "status-badge", text: "Real Devnet test request" }), element("h2", { text: "Review what may become public" }), element("p", { className: "muted", text: "This wallet assertion records a relationship to the exact selected bytes. It is not proof of copyright, identity, originality, permission, or truth." }));
    wrapper.append(lead, ...this.#requestPanels());
    lead.append(this.#button("Prepare exact sponsored proof", () => this.#prepareAttestation()));
    return wrapper;
  }

  #renderAttestationReview(): HTMLElement {
    const plan = this.#attestationPlan;
    const session = this.#session;
    if (plan === undefined || session === undefined) return this.#working("Proof review unavailable", "Restart the local harness before continuing.");
    const wrapper = element("div", { className: "local-stack" });
    const lead = element("section", { className: "panel local-primary-panel" });
    lead.append(
      element("span", { className: "status-badge", text: "Signature review 2 of 2" }),
      element("h2", { text: "Authorize this exact sponsored proof" }),
      element("p", { className: "muted", text: "Your wallet signs the reviewed creator assertion. The dedicated Devnet sponsor pays the proof network fee and rent-exempt account deposit, adds only its required signature, and broadcasts the exact transaction. No token is created or transferred." }),
      dataPanel("Exact chain plan", [
        dataRow("Network", "Solana Devnet"),
        dataRow("Creator authority", plan.creatorAuthority),
        dataRow("Sponsor payer", session.sponsorPayer),
        dataRow("Credential", plan.credentialAddress),
        dataRow("Schema", plan.schemaAddress),
        dataRow("Attestation", plan.attestationAddress),
        dataRow("Exact message SHA-256", plan.messageSha256),
        dataRow("Approval expiry", friendlyExpiry(plan.expiryUnixSeconds)),
      ]),
      element("p", { className: "local-caution", text: "This is an immutable public Devnet record. It is evidence for a broader provenance packet, not a standalone copyright judgment." }),
      element("p", { className: "local-caution", text: "Approve promptly after opening your wallet because the recent Devnet blockhash usually lasts only about 60–90 seconds." }),
    );
    const walletRecovery = this.#renderBoundWalletRecovery();
    if (walletRecovery !== undefined) lead.append(walletRecovery);
    lead.append(
      this.#button("Sign this exact Devnet proof", () => this.#signAttestation(), {
        disabled: this.#currentBoundWallet() === undefined,
      }),
    );
    wrapper.append(lead, ...this.#requestPanels());
    return wrapper;
  }

  #renderAttestationRecovery(): HTMLElement {
    const status = this.#attestationStatus;
    const panel = element("section", { className: "panel local-primary-panel" });
    panel.append(element("span", { className: "status-badge", text: "Status only" }), element("h2", { text: "Check the proof—do not sign again" }), element("p", { className: "muted", text: `Current state: ${status?.state ?? "unknown"}. This check can confirm the retained transaction but can never rebuild or resubmit it.` }));
    if (status?.transactionSignature && SIGNATURE_PATTERN.test(status.transactionSignature)) panel.append(dataPanel("Public transaction evidence", [externalRow("Proof transaction", status.transactionSignature, devnetTransactionExplorerUrl(status.transactionSignature)), externalRow("Attestation account", status.attestationAddress, devnetAccountExplorerUrl(status.attestationAddress))]));
    panel.append(this.#button("Check proof status", () => this.#checkAttestationStatus(), { secondary: true }));
    return panel;
  }

  #renderConfirmed(): HTMLElement {
    const status = this.#attestationStatus;
    const panel = element("section", { className: "panel local-primary-panel local-success" });
    panel.append(element("span", { className: "status-badge", text: "Finalized on Devnet" }), element("h2", { text: "The exact provenance proof is confirmed." }), element("p", { className: "muted", text: "The selected media stayed local. The public Devnet record commits its hashes and reviewed metadata; it does not establish copyright by itself." }));
    if (status?.transactionSignature) panel.append(dataPanel("Open fixed Solana Explorer evidence", [externalRow("Transaction", status.transactionSignature, devnetTransactionExplorerUrl(status.transactionSignature)), externalRow("Attestation account", status.attestationAddress, devnetAccountExplorerUrl(status.attestationAddress))]));
    if (status?.state === "confirmed") {
      const receiptPanel = element("section", { className: "panel local-receipt-panel" });
      receiptPanel.append(
        element("span", { className: "status-badge", text: "Portable public receipt" }),
        element("h2", { text: "Verify the same media independently" }),
        element("p", {
          className: "muted",
          text: "This canonical receipt was assembled from the finalized server record. It contains the opted-in public request, hashes, wallet and SAS account addresses, and transaction references—but never the media file, filename, local path, prompt, private key, or sponsor secret.",
        }),
      );
      try {
        const verifier = element("a", {
          className: "primary-link local-verifier-link",
          text: "Open the local verifier",
        });
        verifier.href = localPublicVerifierUrl(status.receipt);
        verifier.target = "_blank";
        verifier.rel = "noopener noreferrer";
        receiptPanel.append(
          verifier,
          element("p", {
            className: "local-verifier-note",
            text: "This opens the separate public preview at 127.0.0.1:5173. That localhost link is for this development checkpoint and is not yet a public share URL.",
          }),
        );
      } catch {
        receiptPanel.append(
          element("p", {
            className: "local-caution",
            text: "This valid receipt is too large for a safe URL fragment. Its canonical JSON remains available below without truncation.",
          }),
        );
      }

      const details = element("details", { className: "local-json local-receipt-json" });
      details.append(element("summary", { text: "Inspect canonical public receipt JSON" }));
      const pre = element("pre");
      pre.textContent = serializeCanonicalShareableProvenanceReceiptJson(status.receipt);
      details.append(pre);
      receiptPanel.append(details);
      panel.append(receiptPanel);
    }
    return panel;
  }
}

function renderOriginFailure(root: HTMLDivElement): void {
  const shell = element("main", { className: "origin-failure" });
  shell.append(element("span", { className: "eyebrow", text: "Local boundary closed" }), element("h1", { text: "This checkpoint only runs at 127.0.0.1:4173." }), element("p", { text: "No local session, wallet discovery, signature, or network action was started." }));
  root.replaceChildren(shell);
}

function browserDependencies(): LocalDevnetUiDependencies {
  return {
    createClient: () => {
      const localFetch: LocalDevnetFetch = (path, init) =>
        globalThis.fetch(path, init as unknown as RequestInit) as unknown as ReturnType<LocalDevnetFetch>;
      return createLocalDevnetHarnessClient(localFetch);
    },
    createWalletConnection: () => new DevnetWalletConnection(),
    hashBlob: hashBlobSha256,
    signTransaction: signDevnetLegacyTransaction,
    now: () => new Date(),
    randomBytes: (byteLength) => {
      const output = new Uint8Array(byteLength);
      globalThis.crypto.getRandomValues(output);
      return output;
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void import("./local-devnet-styles.css");
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root === null) throw new Error("App root is missing");
  if (!isExactLocalDevnetOrigin(window.location.origin)) {
    renderOriginFailure(root);
  } else {
    const app = new LocalDevnetUi(root, browserDependencies());
    window.addEventListener("pagehide", () => app.dispose(), { once: true });
  }
}
