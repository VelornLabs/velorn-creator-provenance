import {
  assertCreatorProfile,
  CREATOR_PROFILE_CONTRACT,
  createProvenanceRequest,
  serializeCanonicalProvenanceRequestJson,
  type CreatorProfileV1,
  type ProvenanceRequestV1,
} from "../../src/contracts.js";
import { isOfflineDemoRequest } from "./demo-fixtures.js";
import { encodeIssueFragment } from "./fragment-contract.js";

export interface CreatorProfileDraft {
  enabled: boolean;
  displayName: string;
  portfolioUrl: string;
  hireUrl: string;
}

export function profileFromDraft(draft: CreatorProfileDraft): CreatorProfileV1 | undefined {
  if (!draft.enabled) return undefined;
  const displayName = draft.displayName.trim().normalize("NFC");
  if (!displayName) throw new TypeError("Enter a public display name, or turn off the profile option.");
  const profile: CreatorProfileV1 = {
    contract: CREATOR_PROFILE_CONTRACT, version: 1, displayName,
  };
  for (const [key, label] of [["portfolioUrl", "Portfolio"], ["hireUrl", "Contact-for-hire"]] as const) {
    const value = draft[key].trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error();
    } catch {
      throw new TypeError(`${label} must be a full https:// link without embedded usernames or passwords.`);
    }
    profile[key] = value;
  }
  assertCreatorProfile(profile);
  // Leave room for the chain evidence in the bounded shareable receipt link.
  if (new TextEncoder().encode(JSON.stringify(profile)).byteLength > 1_024) {
    throw new TypeError("Please shorten your profile links so the complete proof fits in a shareable link.");
  }
  return profile;
}

/** A profile edit creates a new request, never a modified receipt or chain account. */
export function requestWithProfile(
  original: ProvenanceRequestV1,
  draft: CreatorProfileDraft,
  requestId: string,
): ProvenanceRequestV1 {
  serializeCanonicalProvenanceRequestJson(original);
  if (isOfflineDemoRequest(original) || original.manifest.lifecycle.action !== "issue") {
    throw new TypeError("Profile editing is only available for real issue requests.");
  }
  const profile = profileFromDraft(draft);
  const copy = structuredClone(original);
  delete copy.manifest.profile;
  if (profile) copy.manifest.profile = profile;
  const updated = createProvenanceRequest({
    requestId, mediaSha256: original.media.sha256, manifest: copy.manifest,
  });
  if (updated.commitment.manifestSha256 === original.commitment.manifestSha256) return original;
  if (requestId === original.requestId) throw new TypeError("A changed profile requires a new request ID.");
  encodeIssueFragment(updated);
  return updated;
}
