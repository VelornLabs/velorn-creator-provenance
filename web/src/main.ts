import "./styles.css";

import { hashBlobSha256 } from "./browser-hash.js";
import {
  createOfflineDemoFragments,
  isOfflineDemoRequest,
} from "./demo-fixtures.js";
import {
  parseAppFragment,
  type FragmentCommitmentV1,
  type IssueFragmentV1,
  type VerifyFragmentV1,
} from "./fragment-contract.js";
import {
  DevnetWalletConnection,
  type DevnetWalletSnapshot,
} from "./wallet-standard.js";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("App root is missing");
const root: HTMLDivElement = rootElement;
const MAX_USER_ERROR_CHARACTERS = 240;
const offlineDemoFragments = createOfflineDemoFragments();

function userErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;

  const normalized = error.message.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return fallback;
  if (normalized.length <= MAX_USER_ERROR_CHARACTERS) return normalized;

  return `${normalized
    .slice(0, MAX_USER_ERROR_CHARACTERS - 1)
    .trimEnd()}…`;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  return element;
}

function homeLink(): HTMLAnchorElement {
  const link = createElement("a", { className: "brand", text: "Velorn" });
  link.href = "#";
  link.setAttribute("aria-label", "Velorn Creator Provenance home");
  return link;
}

function pageShell(): { shell: HTMLElement; content: HTMLElement } {
  const shell = createElement("div", { className: "shell" });
  const header = createElement("header", { className: "site-header" });
  const brandRow = createElement("div", { className: "brand-row" });
  const mark = createElement("span", { className: "brand-mark", text: "V" });
  const brandText = createElement("div");
  brandText.append(homeLink());
  brandText.append(
    createElement("span", {
      className: "brand-subtitle",
      text: "Creator Provenance",
    }),
  );
  brandRow.append(mark, brandText);

  const status = createElement("span", {
    className: "network-pill",
    text: "Solana Devnet · preview",
  });
  header.append(brandRow, status);

  const content = createElement("main", { className: "content" });
  const footer = createElement("footer", { className: "site-footer" });
  footer.append(
    createElement("span", {
      text: "Open source · Files stay on this device",
    }),
  );
  const buildSha = import.meta.env.VITE_BUILD_SHA;
  if (typeof buildSha === "string" && /^[0-9a-f]{7,40}$/u.test(buildSha)) {
    footer.append(
      createElement("span", { text: `Build ${buildSha.slice(0, 8)}` }),
    );
  }
  shell.append(header, content, footer);
  return { shell, content };
}

function privacyNotice(): HTMLElement {
  const notice = createElement("aside", { className: "privacy-notice" });
  const icon = createElement("span", {
    className: "privacy-icon",
    text: "✓",
  });
  const copy = createElement("div");
  copy.append(
    createElement("strong", { text: "Local means local" }),
    createElement("p", {
      text: "Selected files are hashed in this browser and are never uploaded. This preview has no analytics or media server. On a real receipt, Solana Devnet is contacted only after you explicitly choose the live check; opening a clearly labeled Explorer link is a separate explicit navigation to explorer.solana.com. On the home page, compatible wallet-extension metadata is detected locally and account authorization still requires a click.",
    }),
  );
  notice.append(icon, copy);
  return notice;
}

function shortAddress(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function walletInvalidationCopy(
  snapshot: DevnetWalletSnapshot,
): string | undefined {
  if (snapshot.invalidation === "wallet-change") {
    return "The wallet changed its accounts or capabilities, so this page cleared the connection. Connect again to continue safely.";
  }
  if (snapshot.invalidation === "wallet-unregistered") {
    return "The wallet extension is no longer available, so this page cleared the connection.";
  }
  if (snapshot.invalidation === "explicit-disconnect") {
    return "This page cleared its local wallet selection. The extension may retain site authorization; manage that separately inside the wallet if needed.";
  }
  if (snapshot.invalidation === "connect-failed") {
    return "The wallet did not complete a compatible Devnet connection.";
  }
  return undefined;
}

function walletReadinessPanel(pageSignal: AbortSignal): HTMLElement {
  const panel = createElement("section", { className: "panel wallet-panel" });
  panel.append(
    createElement("span", {
      className: "status-badge",
      text: "Temporary sprint check",
    }),
    createElement("h2", { text: "Browser wallet readiness" }),
    createElement("p", {
      className: "muted",
      text: "This optional check automatically detects compatible Wallet Standard extension metadata locally. Choosing Connect asks the extension to authorize a Devnet-compatible public account for this page. Velorn itself does not transmit that address, call a Solana RPC, request a signature, prepare or send a transaction, or spend anything; the wallet extension follows its own privacy and network policy.",
    }),
  );

  const status = createElement("div", { className: "wallet-status" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = createElement("div", { className: "wallet-actions" });
  panel.append(status, actions);

  let connection: DevnetWalletConnection;
  let renderedRevision = -1;
  try {
    connection = new DevnetWalletConnection();
  } catch (error: unknown) {
    status.className = "wallet-status wallet-error";
    status.textContent = userErrorMessage(
      error,
      "Wallet discovery is not available in this browser.",
    );
    return panel;
  }

  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const element = createElement("button", {
      className: "wallet-button",
      text: label,
    });
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  };

  const showActionError = (error: unknown, fallback: string): void => {
    if (pageSignal.aborted) return;
    status.className = "wallet-status wallet-error";
    status.textContent = userErrorMessage(error, fallback);
  };

  const renderSnapshot = (snapshot: DevnetWalletSnapshot): void => {
    if (pageSignal.aborted || snapshot.revision < renderedRevision) return;
    renderedRevision = snapshot.revision;
    actions.replaceChildren();
    status.replaceChildren();
    status.className = "wallet-status";

    if (snapshot.status === "connecting") {
      status.textContent = `Waiting for ${snapshot.wallet?.name ?? "wallet"} authorization…`;
      actions.append(
        button("Cancel local connection attempt", () => {
          void connection
            .disconnect()
            .catch(() => undefined);
        }),
      );
      return;
    }
    if (snapshot.status === "selecting-account" && snapshot.wallet !== null) {
      status.textContent = `${snapshot.wallet.name} returned more than one compatible Devnet account. Choose the public address to use for this local check.`;
      for (const account of snapshot.accounts) {
        const accountButton = button(
          `Use ${shortAddress(account.address)}`,
          () => {
            try {
              connection.selectAccount(account.address);
            } catch (error: unknown) {
              showActionError(error, "Could not select that wallet account.");
            }
          },
        );
        accountButton.title = account.address;
        actions.append(accountButton);
      }
      actions.append(
        button("Clear local connection", () => {
          void connection
            .disconnect()
            .catch(() => undefined);
        }),
      );
      return;
    }
    if (
      snapshot.status === "connected" &&
      snapshot.wallet !== null &&
      snapshot.account !== null
    ) {
      status.append(
        createElement("strong", {
          text: `${snapshot.wallet.name} Devnet-compatible account selected`,
        }),
        createElement("span", {
          className: "wallet-address",
          text: snapshot.account.address,
        }),
        createElement("span", {
          className: "wallet-safe-copy",
          text: "Velorn requested no signature or transaction and called no Solana RPC. The wallet extension controls its own authorization and network behavior.",
        }),
      );
      actions.append(
        button("Clear local connection", () => {
          void connection
            .disconnect()
            .catch(() => undefined);
        }),
      );
      return;
    }
    if (snapshot.status === "disposed") {
      status.textContent = "Wallet readiness check closed.";
      return;
    }

    const invalidationCopy = walletInvalidationCopy(snapshot);
    if (snapshot.wallets.length === 0) {
      status.textContent = invalidationCopy
        ? `${invalidationCopy} No compatible Devnet Wallet Standard extension is currently detected.`
        : "No compatible Devnet Wallet Standard extension is currently detected. The verifier remains fully usable without a wallet.";
      return;
    }

    status.textContent =
      invalidationCopy ??
      "Compatible extension metadata was detected locally. No account is authorized until you choose one.";
    for (const wallet of snapshot.wallets) {
      actions.append(
        button(`Connect ${wallet.name}`, () => {
          void connection
            .connect(wallet)
            .catch((error: unknown) =>
              showActionError(error, `${wallet.name} connection was cancelled.`),
            );
        }),
      );
    }
  };

  const stop = connection.subscribe(renderSnapshot);
  renderSnapshot(connection.getSnapshot());
  const dispose = (): void => {
    stop();
    connection.dispose();
  };
  if (pageSignal.aborted) dispose();
  else pageSignal.addEventListener("abort", dispose, { once: true });

  return panel;
}

function fragmentDisclosure(): HTMLElement {
  const notice = createElement("aside", { className: "fragment-warning" });
  const icon = createElement("span", {
    className: "warning-icon",
    text: "!",
  });
  const copy = createElement("div");
  copy.append(
    createElement("strong", { text: "Provenance links are readable" }),
    createElement("p", {
      text: "Media bytes stay on this device, but the #issue/v1 and #verify/v1 URL fragments contain opted-in public manifest, profile, and receipt fields. They are encoded, not encrypted: sharing a link sends those fields to its recipient, and browser history, synced history, clipboard tools, or extensions may retain them.",
    }),
  );
  notice.append(icon, copy);
  return notice;
}

function offlineDemoNotice(): HTMLElement {
  const notice = createElement("aside", { className: "chain-warning" });
  notice.append(
    createElement("strong", { text: "Synthetic offline UI sample" }),
    createElement("p", {
      text: "This deterministic fixture demonstrates the route and local-file checker only. Its placeholder accounts and signatures are not wallet approvals or evidence that an attestation exists on Solana.",
    }),
  );
  return notice;
}

function renderHome(content: HTMLElement, pageSignal: AbortSignal): void {
  const hero = createElement("section", { className: "hero" });
  hero.append(
    createElement("span", { className: "eyebrow", text: "Public preview" }),
    createElement("h1", {
      text: "Trace a finished work back to a creator-controlled receipt.",
    }),
    createElement("p", {
      className: "hero-copy",
      text: "Velorn Creator Provenance is an open-source experiment for committing exact media hashes through Solana. This first browser slice displays canonical public handoff and receipt data, then checks local file hashes.",
    }),
  );

  const cards = createElement("section", { className: "route-grid" });
  const issueCard = createElement("article", { className: "route-card" });
  issueCard.append(
    createElement("span", { className: "step-number", text: "01" }),
    createElement("h2", { text: "Review a request" }),
    createElement("p", {
      text: "An #issue/v1 link contains the full canonical public request: manifest metadata, lifecycle, optional creator profile, hashes, request ID, and network.",
    }),
  );
  const issueSample = createElement("a", {
    className: "primary-link",
    text: "Open synthetic issue sample",
  });
  issueSample.href = offlineDemoFragments.issue;
  issueCard.append(issueSample);
  const verifyCard = createElement("article", { className: "route-card" });
  verifyCard.append(
    createElement("span", { className: "step-number", text: "02" }),
    createElement("h2", { text: "Check a local file" }),
    createElement("p", {
      text: "A #verify/v1 link contains the full canonical public receipt and lets you compare its media commitment with a candidate file locally.",
    }),
  );
  const verifySample = createElement("a", {
    className: "primary-link",
    text: "Open synthetic verifier sample",
  });
  verifySample.href = offlineDemoFragments.verify;
  verifyCard.append(verifySample);
  cards.append(issueCard, verifyCard);

  const boundary = createElement("section", { className: "boundary-card" });
  boundary.append(
    createElement("h2", { text: "What this preview does not claim" }),
    createElement("p", {
      text: "A matching hash is not proof of copyright, identity, originality, permission, or truth. Wallet signing and live Solana Attestation Service verification are intentionally not connected in this slice.",
    }),
    createElement("p", {
      text: "The two sample links above are deterministic offline UI fixtures. Their placeholder accounts and signatures are not evidence of any on-chain attestation.",
    }),
  );

  content.append(
    hero,
    privacyNotice(),
    fragmentDisclosure(),
    walletReadinessPanel(pageSignal),
    cards,
    boundary,
  );
}

function definitionRow(label: string, value: string): HTMLElement {
  const wrapper = createElement("div", { className: "definition-row" });
  wrapper.append(
    createElement("dt", { text: label }),
    createElement("dd", { text: value }),
  );
  return wrapper;
}

function fixedLinkRow(
  label: string,
  visibleUrl: string,
  fixedHref: string,
): HTMLElement {
  const wrapper = createElement("div", { className: "definition-row" });
  const value = createElement("dd");
  const link = createElement("a", {
    className: "evidence-link",
    text: visibleUrl,
  });
  link.href = fixedHref;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  value.append(link);
  wrapper.append(createElement("dt", { text: label }), value);
  return wrapper;
}

function dataPanel(
  title: string,
  rows: readonly HTMLElement[],
  copy?: string,
): HTMLElement {
  const panel = createElement("section", { className: "panel" });
  panel.append(createElement("h2", { text: title }));
  if (copy) {
    panel.append(createElement("p", { className: "muted", text: copy }));
  }
  const list = createElement("dl", { className: "definition-list" });
  list.append(...rows);
  panel.append(list);
  return panel;
}

function commitmentPanel(
  commitment: FragmentCommitmentV1,
  title = "Public commitment",
  copy = "These four values form the compact public commitment that would be carried by an attestation transaction if this request were issued.",
): HTMLElement {
  return dataPanel(
    title,
    [
      definitionRow("Media SHA-256", commitment.mediaSha256),
      definitionRow("Manifest SHA-256", commitment.manifestSha256),
      definitionRow("Statement type", commitment.statementType),
      definitionRow("Commitment version", String(commitment.version)),
    ],
    copy,
  );
}

function requestPanels(
  request: IssueFragmentV1,
  headingPrefix = "Request",
): HTMLElement[] {
  const overview = dataPanel(
    `${headingPrefix} identity`,
    [
      definitionRow("Request contract", request.contract),
      definitionRow("Contract version", String(request.version)),
      definitionRow("Request ID", request.requestId),
      definitionRow("Network", request.network),
      definitionRow("Requested media SHA-256", request.media.sha256),
    ],
    "The request ID correlates this handoff. It is not itself an on-chain provenance claim.",
  );

  const manifest = request.manifest;
  const manifestPanel = dataPanel(
    "Hash-bound public manifest",
    [
      definitionRow("Manifest contract", manifest.contract),
      definitionRow("Manifest version", String(manifest.version)),
      definitionRow("Creator statement", manifest.statement),
      definitionRow("Creator-declared at", manifest.declaredAt),
      definitionRow("Media byte length", manifest.media.byteLength),
      definitionRow(
        "Declared MIME type",
        manifest.media.mimeType ?? "Not included in this request",
      ),
    ],
    "These exact public fields are bound by the manifest SHA-256. The declared time and MIME type are creator/client declarations, not independently inferred facts.",
  );

  const lifecycle = manifest.lifecycle;
  const lifecycleRows = [
    definitionRow("Lifecycle contract", lifecycle.contract),
    definitionRow("Lifecycle version", String(lifecycle.version)),
    definitionRow("Action", lifecycle.action),
  ];
  if (lifecycle.action === "supersede") {
    lifecycleRows.push(
      definitionRow(
        "Previous attestation",
        lifecycle.previousAttestationAddress,
      ),
    );
  }
  if (lifecycle.action === "revoke") {
    lifecycleRows.push(
      definitionRow("Target attestation", lifecycle.targetAttestationAddress),
    );
  }
  const lifecyclePanel = dataPanel(
    "Lifecycle declaration",
    lifecycleRows,
    "A lifecycle declaration is immutable public data. Discovering later supersede or revoke declarations still requires an indexer.",
  );

  const profile = manifest.profile;
  let profilePanel: HTMLElement;
  if (profile) {
    profilePanel = dataPanel(
      "Optional public creator profile",
      [
        definitionRow("Profile contract", profile.contract),
        definitionRow("Profile version", String(profile.version)),
        definitionRow("Display name", profile.displayName),
        definitionRow(
          "Portfolio URL",
          profile.portfolioUrl ?? "Not included in this request",
        ),
        definitionRow(
          "Hire URL",
          profile.hireUrl ?? "Not included in this request",
        ),
      ],
      "These are self-asserted public profile fields. They do not verify legal identity, ownership of a website, or authority to represent another person. Profile URLs are displayed as text in this preview.",
    );
  } else {
    profilePanel = createElement("section", {
      className: "panel profile-empty",
    });
    profilePanel.append(
      createElement("h2", { text: "Optional public creator profile" }),
      createElement("p", {
        className: "muted",
        text: "No creator profile fields are included in this canonical request.",
      }),
    );
  }

  return [
    overview,
    manifestPanel,
    lifecyclePanel,
    profilePanel,
    commitmentPanel(request.commitment),
  ];
}

function devnetAccountUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}

function devnetTransactionUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function chainEvidencePanels(
  receipt: VerifyFragmentV1["chainReceipt"],
): HTMLElement[] {
  const overview = dataPanel(
    "Canonical chain receipt",
    [
      definitionRow("Chain receipt version", String(receipt.receiptVersion)),
      definitionRow("Network", receipt.network),
      definitionRow("Devnet genesis hash", receipt.genesisHash),
      definitionRow("SAS program ID", receipt.sasProgramId),
      definitionRow("Credential name", receipt.credentialName),
      definitionRow("Schema name", receipt.schemaName),
      definitionRow("Credential authority", receipt.credentialAuthority),
      definitionRow("Authorized signer", receipt.authorizedSigner),
      definitionRow("Subject nonce", receipt.subjectNonce),
      definitionRow("Expiry (Unix seconds)", receipt.expiryUnixSeconds),
      definitionRow("Receipt written at", receipt.receiptWrittenAt),
      definitionRow("SAS library version", receipt.implementation.sasLib),
      definitionRow("Solana Kit version", receipt.implementation.solanaKit),
    ],
    "These values came from the transported canonical public receipt. Their structure and cross-field bindings are checked before any network request; only the separate live-check result can confirm their current Devnet state.",
  );

  const accounts = dataPanel("SAS account evidence", [
    definitionRow("Credential address", receipt.credentialAddress),
    fixedLinkRow(
      "Credential Explorer URL",
      receipt.accountExplorerUrls.credential,
      devnetAccountUrl(receipt.credentialAddress),
    ),
    definitionRow("Schema address", receipt.schemaAddress),
    fixedLinkRow(
      "Schema Explorer URL",
      receipt.accountExplorerUrls.schema,
      devnetAccountUrl(receipt.schemaAddress),
    ),
    definitionRow("Attestation address", receipt.attestationAddress),
    fixedLinkRow(
      "Attestation Explorer URL",
      receipt.accountExplorerUrls.attestation,
      devnetAccountUrl(receipt.attestationAddress),
    ),
  ]);

  const transactions = dataPanel("Transaction evidence", [
    definitionRow(
      "Create credential signature",
      receipt.transactions.createCredential.signature,
    ),
    fixedLinkRow(
      "Create credential Explorer URL",
      receipt.transactions.createCredential.explorerUrl,
      devnetTransactionUrl(receipt.transactions.createCredential.signature),
    ),
    definitionRow(
      "Create schema signature",
      receipt.transactions.createSchema.signature,
    ),
    fixedLinkRow(
      "Create schema Explorer URL",
      receipt.transactions.createSchema.explorerUrl,
      devnetTransactionUrl(receipt.transactions.createSchema.signature),
    ),
    definitionRow(
      "Create attestation signature",
      receipt.transactions.createAttestation.signature,
    ),
    fixedLinkRow(
      "Create attestation Explorer URL",
      receipt.transactions.createAttestation.explorerUrl,
      devnetTransactionUrl(receipt.transactions.createAttestation.signature),
    ),
  ]);

  return [
    overview,
    accounts,
    transactions,
    commitmentPanel(
      receipt.commitment,
      "Chain receipt commitment",
      "The transported receipt claims these four values were carried by its attestation account. Treat that as a receipt claim until the separate live Devnet check passes.",
    ),
  ];
}

function chainCheckLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("Pda", "PDA")
    .replaceAll("Sas", "SAS")
    .replace(/^./u, (character) => character.toUpperCase());
}

function syntheticChainCheckPanel(): HTMLElement {
  const panel = createElement("section", { className: "panel chain-check-panel" });
  panel.append(
    createElement("span", { className: "status-badge", text: "Live check unavailable" }),
    createElement("h2", { text: "Synthetic sample—no Solana request" }),
    createElement("p", {
      className: "muted",
      text: "This built-in sample contains placeholder accounts and signatures, so the page will not contact an RPC endpoint for it. Open a receipt from a real confirmed proof to use live verification.",
    }),
  );
  return panel;
}

function liveChainCheck(
  receipt: VerifyFragmentV1,
  pageSignal: AbortSignal,
): HTMLElement {
  const panel = createElement("section", { className: "panel chain-check-panel" });
  panel.append(
    createElement("span", { className: "status-badge", text: "Optional live check" }),
    createElement("h2", { text: "Check the current Solana Devnet record" }),
    createElement("p", {
      className: "muted",
      text: "Nothing is queried merely because this receipt link was opened. Only after you explicitly choose the live check does this page contact the fixed Solana Devnet RPC. That provider can see your IP address, this page's origin, and the already-public addresses and signatures being checked. Your media bytes, filename, and local path are never sent.",
    }),
  );

  const actions = createElement("div", { className: "chain-check-actions" });
  const check = createElement("button", {
    className: "wallet-button",
    text: "Check live Solana Devnet",
  });
  check.type = "button";
  const cancel = createElement("button", {
    className: "secondary-button",
    text: "Cancel live check",
  });
  cancel.type = "button";
  cancel.hidden = true;
  actions.append(check, cancel);

  const result = createElement("div", { className: "hash-result neutral" });
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");
  result.textContent = "Live Devnet has not been checked.";
  const checkDetails = createElement("details", {
    className: "chain-check-details",
  });
  const checkSummary = createElement("summary", {
    text: "Show technical checks",
  });
  const checks = createElement("ul", { className: "chain-check-list" });
  checkDetails.append(checkSummary, checks);
  checkDetails.hidden = true;
  panel.append(actions, result, checkDetails);

  let activeController: AbortController | undefined;
  const cancelActive = (): void => {
    activeController?.abort();
  };
  if (pageSignal.aborted) cancelActive();
  else pageSignal.addEventListener("abort", cancelActive, { once: true });
  cancel.addEventListener("click", cancelActive);

  check.addEventListener("click", () => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const pageAbort = (): void => controller.abort();
    if (pageSignal.aborted) controller.abort();
    else pageSignal.addEventListener("abort", pageAbort, { once: true });

    check.disabled = true;
    cancel.hidden = false;
    checkDetails.hidden = true;
    checks.replaceChildren();
    result.className = "hash-result working";
    result.textContent = "Checking the fixed Solana Devnet endpoint…";

    void import("../../src/verify-chain.js")
      .then(({ verifyShareableReceiptOnDevnet }) =>
        verifyShareableReceiptOnDevnet(receipt, { signal: controller.signal }),
      )
      .then((verification) => {
        if (activeController !== controller || pageSignal.aborted) return;
        if (verification.status === "valid") {
          result.className = "hash-result match";
          result.textContent = "Live Devnet verified: the current SAS accounts, relationships, signer, expiry, and exact commitment all match this receipt.";
        } else if (verification.status === "invalid") {
          result.className = "hash-result mismatch";
          result.textContent = "The current Devnet record did not pass every receipt check. This may be a mismatch, an expired record, or a Devnet reset.";
        } else if (verification.status === "cancelled") {
          result.className = "hash-result neutral";
          result.textContent = "Live Devnet check cancelled. The local file checker still works.";
        } else {
          result.className = "hash-result neutral";
          result.textContent = "Devnet could not be checked right now. The receipt has not been marked invalid, and the local file checker still works.";
        }

        if (
          verification.status === "valid" ||
          verification.status === "invalid"
        ) {
          let passedCount = 0;
          let totalCount = 0;
          for (const [name, passed] of Object.entries(verification.checks)) {
            totalCount += 1;
            if (passed) passedCount += 1;
            const item = createElement("li", {
              className: passed ? "check-pass" : "check-fail",
              text: `${passed ? "Pass" : "Fail"} · ${chainCheckLabel(name)}`,
            });
            checks.append(item);
          }
          checkSummary.textContent = `${passedCount}/${totalCount} live technical checks passed`;
          checkDetails.hidden = false;
        }
      })
      .catch(() => {
        if (activeController !== controller || pageSignal.aborted) return;
        result.className = "hash-result neutral";
        result.textContent = controller.signal.aborted
          ? "Live Devnet check cancelled. The local file checker still works."
          : "Devnet could not be checked right now. The receipt has not been marked invalid, and the local file checker still works.";
      })
      .finally(() => {
        pageSignal.removeEventListener("abort", pageAbort);
        if (activeController !== controller) return;
        activeController = undefined;
        check.disabled = false;
        cancel.hidden = true;
      });
  });

  const limitation = createElement("p", { className: "chain-check-limitation" });
  limitation.textContent = "The account/PDA/schema/signer/payload checks are the substantive live proof. Transaction signatures are checked as successful supporting references; this prototype does not yet decode each historical transaction to prove which instruction created each account. Receipt time is service assembly time, not an on-chain timestamp. None of these checks establishes copyright by itself.";
  panel.append(limitation);
  return panel;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1_024;
  let unit = units[0] ?? "KB";
  for (let index = 1; index < units.length && amount >= 1_024; index += 1) {
    amount /= 1_024;
    unit = units[index] ?? unit;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function localFileCheck(
  expectedSha256: string,
  pageSignal: AbortSignal,
): HTMLElement {
  const panel = createElement("section", { className: "panel file-panel" });
  panel.append(
    createElement("h2", { text: "Check media bytes locally" }),
    createElement("p", {
      className: "muted",
      text: "Choose a candidate file. Its bytes stay on this device and are read in small chunks.",
    }),
  );

  const picker = createElement("label", { className: "file-picker" });
  picker.append(
    createElement("span", { className: "file-picker-title", text: "Choose media" }),
    createElement("span", {
      className: "file-picker-copy",
      text: "Nothing is uploaded",
    }),
  );
  const input = createElement("input");
  input.type = "file";
  input.className = "visually-hidden";
  picker.append(input);

  const progress = createElement("progress", { className: "hash-progress" });
  progress.max = 1;
  progress.value = 0;
  progress.hidden = true;

  const result = createElement("div", { className: "hash-result neutral" });
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");
  result.textContent = "No file selected.";

  const cancel = createElement("button", {
    className: "secondary-button",
    text: "Cancel hashing",
  });
  cancel.type = "button";
  cancel.hidden = true;

  let controller: AbortController | undefined;
  const abortForPageExit = (): void => {
    const activeController = controller;
    controller = undefined;
    activeController?.abort();
  };
  if (pageSignal.aborted) {
    abortForPageExit();
  } else {
    pageSignal.addEventListener("abort", abortForPageExit, { once: true });
  }

  cancel.addEventListener("click", () => controller?.abort());
  input.addEventListener("change", () => {
    controller?.abort();
    const file = input.files?.item(0);
    if (!file) {
      result.className = "hash-result neutral";
      result.textContent = "No file selected.";
      progress.hidden = true;
      cancel.hidden = true;
      return;
    }

    const runController = new AbortController();
    controller = runController;
    progress.hidden = false;
    progress.value = 0;
    cancel.hidden = false;
    result.className = "hash-result working";
    result.textContent = `Hashing ${formatBytes(file.size)} locally…`;

    void hashBlobSha256(file, {
      signal: runController.signal,
      onProgress: ({ ratio, processedBytes, totalBytes }) => {
        if (controller !== runController) return;
        progress.value = ratio;
        result.textContent = `Hashing locally… ${Math.round(ratio * 100)}% (${formatBytes(processedBytes)} of ${formatBytes(totalBytes)})`;
      },
    })
      .then((digest) => {
        if (controller !== runController) return;
        controller = undefined;
        progress.hidden = true;
        cancel.hidden = true;
        if (digest === expectedSha256) {
          result.className = "hash-result match";
          result.textContent =
            "Exact byte match: this file has the media hash carried by the link.";
        } else {
          result.className = "hash-result mismatch";
          result.textContent =
            "No match: this file differs from the media hash carried by the link.";
        }
      })
      .catch((error: unknown) => {
        if (controller !== runController) return;
        controller = undefined;
        progress.hidden = true;
        cancel.hidden = true;
        if (error instanceof DOMException && error.name === "AbortError") {
          result.className = "hash-result neutral";
          result.textContent = "Hashing cancelled. No file data left this device.";
          return;
        }
        result.className = "hash-result mismatch";
        result.textContent = userErrorMessage(
          error,
          "Could not hash this file locally.",
        );
      });
  });

  panel.append(picker, progress, cancel, result);
  return panel;
}

function pageHeading(eyebrow: string, heading: string, copy: string): HTMLElement {
  const section = createElement("section", { className: "page-heading" });
  section.append(
    createElement("span", { className: "eyebrow", text: eyebrow }),
    createElement("h1", { text: heading }),
    createElement("p", { className: "hero-copy", text: copy }),
  );
  return section;
}

function renderIssue(
  content: HTMLElement,
  payload: IssueFragmentV1,
  pageSignal: AbortSignal,
): void {
  content.append(
    pageHeading(
      "Issue request · preview only",
      "Review what would become public.",
      "This canonical request shows every public value in the handoff. Its manifest metadata is hash-bound to the compact commitment; it contains no media bytes, local filename, prompt, or private key.",
    ),
  );
  if (isOfflineDemoRequest(payload)) content.append(offlineDemoNotice());
  content.append(
    privacyNotice(),
    fragmentDisclosure(),
    ...requestPanels(payload),
    localFileCheck(payload.commitment.mediaSha256, pageSignal),
  );

  const disabled = createElement("section", { className: "boundary-card" });
  disabled.append(
    createElement("span", { className: "status-badge", text: "Not connected" }),
    createElement("h2", { text: "Wallet issuance comes next" }),
    createElement("p", {
      text: "This issue page does not show the wallet readiness panel, request a signature, pay a fee, or write to Solana. Nothing will happen merely because this link was opened.",
    }),
  );
  content.append(disabled);
}

function renderVerify(
  content: HTMLElement,
  payload: VerifyFragmentV1,
  pageSignal: AbortSignal,
): void {
  content.append(
    pageHeading(
      "Verifier · local hash slice",
      "Inspect the full receipt and check the exact media bytes.",
      "This canonical receipt includes its full public request, any public creator profile, SAS accounts, and transaction evidence. You can compare local media bytes without a network request, or explicitly check the current Devnet record.",
    ),
  );
  if (isOfflineDemoRequest(payload.request)) content.append(offlineDemoNotice());
  content.append(privacyNotice(), fragmentDisclosure());

  const livePanel = isOfflineDemoRequest(payload.request)
    ? syntheticChainCheckPanel()
    : liveChainCheck(payload, pageSignal);

  content.append(
    livePanel,
    dataPanel("Receipt envelope", [
      definitionRow("Receipt contract", payload.contract),
      definitionRow("Contract version", String(payload.version)),
    ]),
    ...requestPanels(payload.request, "Receipt request"),
    ...chainEvidencePanels(payload.chainReceipt),
    localFileCheck(payload.request.commitment.mediaSha256, pageSignal),
  );
}

function renderError(content: HTMLElement, error: unknown): void {
  const card = createElement("section", { className: "error-card" });
  card.append(
    createElement("span", { className: "eyebrow", text: "Link rejected" }),
    createElement("h1", { text: "This provenance link is not valid." }),
    createElement("p", {
      text: userErrorMessage(
        error,
        "The fragment could not be parsed safely.",
      ),
    }),
  );
  const link = createElement("a", { className: "primary-link", text: "Return home" });
  link.href = "#";
  card.append(link);
  content.append(card);
}

let activePageController: AbortController | undefined;

function render(): void {
  activePageController?.abort();
  const pageController = new AbortController();
  activePageController = pageController;

  const { shell, content } = pageShell();
  try {
    const route = parseAppFragment(window.location.hash);
    if (route.route === "home") renderHome(content, pageController.signal);
    if (route.route === "issue") {
      renderIssue(content, route.payload, pageController.signal);
    }
    if (route.route === "verify") {
      renderVerify(content, route.payload, pageController.signal);
    }
  } catch (error: unknown) {
    renderError(content, error);
  }
  root.replaceChildren(shell);
}

window.addEventListener("hashchange", render);
window.addEventListener("pagehide", () => activePageController?.abort());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) render();
});
render();
