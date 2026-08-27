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
      text: "Selected files are hashed in this browser. This preview has no upload, analytics, wallet connection, RPC connection, or server API. Opening a clearly labeled Explorer link is an explicit navigation to explorer.solana.com.",
    }),
  );
  notice.append(icon, copy);
  return notice;
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

function renderHome(content: HTMLElement): void {
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

  content.append(hero, privacyNotice(), fragmentDisclosure(), cards, boundary);
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
    "These values came from the transported canonical public receipt. This offline page has validated their structure and cross-field bindings, but has not fetched the referenced accounts.",
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
      "The transported receipt claims these four values were carried by its attestation transaction. This offline page has not fetched that transaction or account.",
    ),
  ];
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
      text: "This browser slice does not discover a wallet, request a signature, pay a fee, or write to Solana. Nothing will happen merely because this link was opened.",
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
      "This canonical receipt includes its full public request, any public creator profile, SAS accounts, and transaction evidence. Live account verification is not connected in this browser slice yet.",
    ),
  );
  if (isOfflineDemoRequest(payload.request)) content.append(offlineDemoNotice());
  content.append(privacyNotice(), fragmentDisclosure());

  const warning = createElement("div", { className: "chain-warning" });
  warning.append(
    createElement("strong", { text: "Chain status not checked in this slice" }),
    createElement("p", {
      text: "The link is canonical and internally consistent, but this page has not queried Solana. A local file match only means its bytes match the receipt's media hash; it does not establish that the referenced SAS accounts currently exist or contain this commitment.",
    }),
  );

  content.append(
    warning,
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
    if (route.route === "home") renderHome(content);
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
