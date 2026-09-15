import { assertCreatorProfile, type CreatorProfileV1 } from "../../src/contracts.js";

export function creatorProfilePanel(
  profile: CreatorProfileV1 | undefined,
  receipt = false,
): HTMLElement {
  const panel = document.createElement("section");
  panel.className = `panel creator-profile${profile ? "" : " profile-empty"}`;
  const heading = document.createElement("h2");
  heading.textContent = "Optional public creator profile";
  panel.append(heading);
  const copy = document.createElement("p");
  copy.className = "muted";
  if (!profile) {
    copy.textContent = "No creator profile fields are included in this canonical request.";
    panel.append(copy);
    return panel;
  }
  assertCreatorProfile(profile);
  const name = document.createElement("p");
  name.className = "creator-name";
  name.textContent = profile.displayName;
  copy.textContent = receipt
    ? "Wallet-asserted profile, not verified identity. Only a passing live check ties these fields to the signer below; it does not authenticate the name, websites, or professional history."
    : "Self-declared profile for review, not yet a wallet-signed claim. These fields will be public in the link. A proof does not verify identity or ownership of these websites.";
  panel.append(name, copy);
  const links = document.createElement("div");
  links.className = "creator-links";
  for (const [label, href] of [["Portfolio", profile.portfolioUrl], ["Contact for hire", profile.hireUrl]]) {
    if (!href) continue;
    const link = document.createElement("a");
    link.className = "evidence-link";
    link.textContent = `${label}: ${href}`;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    links.append(link);
  }
  panel.append(links);
  if (links.childElementCount) {
    const warning = document.createElement("p");
    warning.className = "profile-link-note";
    warning.textContent = "Creator-provided external links open a new tab. Velorn does not endorse their content. Never enter a wallet recovery phrase on a linked site.";
    panel.append(warning);
  }
  const format = document.createElement("p");
  format.className = "profile-link-note";
  format.textContent = `Profile contract: ${profile.contract} · Version ${profile.version}`;
  panel.append(format);
  return panel;
}
