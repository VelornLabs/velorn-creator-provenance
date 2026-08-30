import type { ShareableProvenanceReceiptV1 } from "../../src/contracts.js";
import { encodeVerifyFragment } from "./fragment-contract.js";

export const PUBLIC_VERIFIER_BASE_URL =
  "https://velornlabs.github.io/velorn-creator-provenance/" as const;

export function publicVerifierUrl(
  receipt: ShareableProvenanceReceiptV1,
): string {
  return new URL(
    encodeVerifyFragment(receipt),
    PUBLIC_VERIFIER_BASE_URL,
  ).href;
}
