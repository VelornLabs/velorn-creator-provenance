import type { ProvenanceRequestV1 } from "../../src/contracts.js";
import { encodeIssueFragment } from "./fragment-contract.js";
import { profileFromDraft, requestWithProfile } from "./creator-profile.js";
import { creatorProfilePanel } from "./creator-profile-panel.js";

export function creatorProfileEditor(
  request: ProvenanceRequestV1,
  signal: AbortSignal,
  onEditingChange: (editing: boolean) => void,
  onReview: (fragment: string) => void,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "panel profile-editor";
  const summary = document.createElement("summary");
  summary.textContent = request.manifest.profile ? "Change or remove the public profile" : "Add an optional public creator profile";
  const form = document.createElement("form");
  form.noValidate = true;
  const description = document.createElement("p");
  description.className = "muted";
  description.textContent = "Add a name and links people can use to find your work. This is optional. Drafts stay on this page until you choose Review new request. That creates a new readable link and manifest hash; it cannot edit or revoke an existing proof. You will select the media again and review any transaction separately.";
  const optIn = document.createElement("label");
  optIn.className = "profile-opt-in";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  const optInText = document.createElement("span");
  optInText.textContent = "Include my profile in the public request";
  optIn.append(enabled, optInText);
  const fields = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Public profile fields";
  fields.append(legend);
  const input = (labelText: string, type: string, maxLength: number): HTMLInputElement => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = labelText;
    const element = document.createElement("input");
    element.type = type;
    element.maxLength = maxLength;
    element.autocomplete = "off";
    element.spellcheck = false;
    label.append(text, element);
    fields.append(label);
    return element;
  };
  const displayName = input("Display name (required when included, up to 80 characters)", "text", 80);
  const portfolioUrl = input("Portfolio link (optional, https://)", "url", 2_048);
  const hireUrl = input("Contact-for-hire link (optional, https://)", "url", 2_048);
  const preview = document.createElement("div");
  const previewTitle = document.createElement("h3");
  previewTitle.textContent = "What will become public";
  const status = document.createElement("p");
  status.className = "hash-result neutral";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "wallet-actions";
  const review = document.createElement("button");
  review.type = "submit";
  review.className = "wallet-button";
  review.textContent = "Review new request";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "Cancel profile changes";
  actions.append(review, cancel);
  form.append(description, optIn, fields, previewTitle, preview, status, actions);
  details.append(summary, form);
  const draft = () => ({ enabled: enabled.checked, displayName: displayName.value, portfolioUrl: portfolioUrl.value, hireUrl: hireUrl.value });
  const update = (): void => {
    fields.disabled = !enabled.checked;
    fields.hidden = !enabled.checked;
    try {
      const profile = profileFromDraft(draft());
      preview.replaceChildren(creatorProfilePanel(profile));
      // Use a non-persisted candidate ID for validation; generate the real ID only on review.
      const candidate = requestWithProfile(request, draft(), request.requestId === "profile_review" ? "profile_review_alternate" : "profile_review");
      review.disabled = candidate === request;
      status.className = "hash-result neutral";
      status.textContent = review.disabled
        ? "No profile changes. Close this section to continue with the current request."
        : "Review creates a new request only. Nothing is uploaded, signed, or submitted to Solana. Public links are encoded, not encrypted, and may remain in browser history.";
    } catch (error) {
      preview.replaceChildren();
      review.disabled = true;
      status.className = "hash-result mismatch";
      status.textContent = error instanceof Error ? error.message : "Check your profile fields.";
    }
  };
  const reset = (): void => {
    enabled.checked = !!request.manifest.profile;
    displayName.value = request.manifest.profile?.displayName ?? "";
    portfolioUrl.value = request.manifest.profile?.portfolioUrl ?? "";
    hireUrl.value = request.manifest.profile?.hireUrl ?? "";
    update();
  };
  reset();
  form.addEventListener("input", update, { signal });
  details.addEventListener("toggle", () => {
    if (!details.open) reset();
    onEditingChange(details.open);
  }, { signal });
  cancel.addEventListener("click", () => { reset(); details.open = false; }, { signal });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (signal.aborted || review.disabled) return;
    try {
      const updated = requestWithProfile(request, draft(), `request_devnet_${crypto.randomUUID()}`);
      if (updated !== request) onReview(encodeIssueFragment(updated));
    } catch (error) {
      status.className = "hash-result mismatch";
      status.textContent = error instanceof Error ? error.message : "Could not prepare the profile request.";
    }
  }, { signal });
  return details;
}
