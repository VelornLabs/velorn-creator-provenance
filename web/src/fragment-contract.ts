import {
  parseCanonicalProvenanceRequestJson,
  parseCanonicalShareableProvenanceReceiptJson,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
  type ProvenanceRequestV1,
  type ShareableProvenanceReceiptV1,
} from "../../src/contracts.js";

export const FRAGMENT_VERSION = 1 as const;
export const MAX_FRAGMENT_CHARACTERS = 8_192;
export const MAX_FRAGMENT_PAYLOAD_BYTES = 6_000;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** The #issue/v1 payload is the canonical, hash-bound request contract. */
export type IssueFragmentV1 = ProvenanceRequestV1;
export type FragmentCommitmentV1 = ProvenanceRequestV1["commitment"];

/**
 * The transported value is exactly ShareableProvenanceReceiptV1. These
 * non-enumerable derived fields preserve the current read-only UI boundary
 * without creating a second serialized receipt schema.
 */
export type VerifyFragmentV1 = ShareableProvenanceReceiptV1 & {
  readonly network: ProvenanceRequestV1["network"];
  readonly attestationAddress: string;
  readonly attestationSignature: string;
  readonly commitment: ProvenanceRequestV1["commitment"];
};

export type AppFragmentRoute =
  | { route: "home" }
  | { route: "issue"; payload: IssueFragmentV1 }
  | { route: "verify"; payload: VerifyFragmentV1 };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    throw new TypeError("Fragment payload must be unpadded base64url");
  }
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(base64 + padding);
  } catch {
    throw new TypeError("Fragment payload is not valid base64url");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== encoded) {
    throw new TypeError("Fragment payload is not canonical base64url");
  }
  return bytes;
}

function encodePayload(canonicalJson: string): string {
  const bytes = textEncoder.encode(canonicalJson);
  if (bytes.byteLength > MAX_FRAGMENT_PAYLOAD_BYTES) {
    throw new TypeError(
      `Fragment payload exceeds ${MAX_FRAGMENT_PAYLOAD_BYTES} bytes`,
    );
  }
  return bytesToBase64Url(bytes);
}

function decodePayload(encoded: string): string {
  const bytes = base64UrlToBytes(encoded);
  if (bytes.byteLength > MAX_FRAGMENT_PAYLOAD_BYTES) {
    throw new TypeError(
      `Fragment payload exceeds ${MAX_FRAGMENT_PAYLOAD_BYTES} bytes`,
    );
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new TypeError("Fragment payload is not valid UTF-8");
  }
}

function buildFragment(route: "issue" | "verify", encoded: string): string {
  const fragment = `#${route}/v${FRAGMENT_VERSION}/${encoded}`;
  if (fragment.length > MAX_FRAGMENT_CHARACTERS) {
    throw new TypeError(
      `Encoded fragment exceeds ${MAX_FRAGMENT_CHARACTERS} characters`,
    );
  }
  return fragment;
}

export function encodeIssueFragment(value: ProvenanceRequestV1): string {
  return buildFragment(
    "issue",
    encodePayload(serializeCanonicalProvenanceRequestJson(value)),
  );
}

export function encodeVerifyFragment(
  value: ShareableProvenanceReceiptV1,
): string {
  return buildFragment(
    "verify",
    encodePayload(serializeCanonicalShareableProvenanceReceiptJson(value)),
  );
}

function withVerifyView(
  receipt: ShareableProvenanceReceiptV1,
): VerifyFragmentV1 {
  const view = receipt as VerifyFragmentV1;
  Object.defineProperties(view, {
    network: { value: receipt.request.network, enumerable: false },
    attestationAddress: {
      value: receipt.chainReceipt.attestationAddress,
      enumerable: false,
    },
    attestationSignature: {
      value: receipt.chainReceipt.transactions.createAttestation.signature,
      enumerable: false,
    },
    commitment: { value: receipt.request.commitment, enumerable: false },
  });
  return view;
}

export function parseAppFragment(hash: string): AppFragmentRoute {
  if (hash === "" || hash === "#" || hash === "#/") {
    return { route: "home" };
  }
  if (typeof hash !== "string" || !hash.startsWith("#")) {
    throw new TypeError("App fragment must begin with #");
  }
  if (hash.length > MAX_FRAGMENT_CHARACTERS) {
    throw new TypeError(
      `Encoded fragment exceeds ${MAX_FRAGMENT_CHARACTERS} characters`,
    );
  }

  const parts = hash.slice(1).split("/");
  if (parts.length !== 3) {
    throw new TypeError("Fragment route must contain exactly three segments");
  }
  const [route, version, encoded] = parts;
  if (version !== `v${FRAGMENT_VERSION}` || !encoded) {
    throw new TypeError("Fragment route uses an unsupported version");
  }

  const json = decodePayload(encoded);
  if (route === "issue") {
    const payload = parseCanonicalProvenanceRequestJson(json);
    return { route: "issue", payload };
  }
  if (route === "verify") {
    const receipt = parseCanonicalShareableProvenanceReceiptJson(json);
    return { route: "verify", payload: withVerifyView(receipt) };
  }
  throw new TypeError("Fragment route must be issue or verify");
}
