# Architecture

This repository contains a verified Devnet baseline and an in-progress Eternal
sprint browser/sponsorship design. The layers are deliberately separated so an
offline preview cannot be mistaken for a production wallet or chain service.

## Local commitment and public manifest

The client hashes the exact bytes of a selected media file with SHA-256. Media
bytes, filenames, local paths, prompts, and project data stay on the device.

A canonical public manifest can include creator-declared media size and MIME
type, lifecycle intent, and an optional self-asserted display name, portfolio
URL, and hire URL. Its exact canonical UTF-8 representation is hash-bound to the
media commitment. These selected fields are not written directly on-chain, but
they are embedded in the readable `#issue/v1` and `#verify/v1` links. Sharing a
link sends them to its recipient, and browser or clipboard history may retain
them. URL encoding is not encryption.

The manifest is intentionally not described as C2PA. A production C2PA adapter
must follow C2PA's format-specific hard-binding rules instead of naïvely hashing
a file and then embedding data into it.

## Versioned contract and browser layer

`src/contracts.ts` defines the versioned profile, lifecycle, manifest, request,
and shareable-receipt contracts. The ordinary v1 parsers preserve the broader
published compatibility envelope. Public handoffs use the strict canonical
parse/serialize helpers, which reject alternate JSON formatting, duplicate
keys, unexpected public-wire properties, malformed Solana evidence, and
non-canonical receipt time/expiry values.

`web/src/fragment-contract.ts` transports those exact strict contracts in
bounded URL fragments. Its 6,000-byte payload cap is independent of the general
64 KiB contract JSON limit. The static browser UI:

- displays every transported public field;
- hashes a selected candidate file locally in bounded chunks;
- compares that digest with the transported commitment;
- rejects malformed, oversized, non-canonical, or internally inconsistent
  links; and
- clearly states that it has not queried Solana.

The current browser slice includes an optional Wallet Standard discovery and
connection-only readiness check. It has no wallet-signing call, RPC connection,
upload, analytics, server API, or issuance path. Its deterministic home-page
examples are synthetic UI fixtures, not chain evidence.

## Solana attestation baseline

The verified baseline uses the deployed Solana Attestation Service program on
Devnet:

`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`

The baseline CLI uses a disposable creator signer as credential authority,
authorized signer, and native signer recorded by the attestation account. A
fresh public nonce address makes the attestation PDA unique; the nonce holds no
funds and does not sign.

The SAS schema contains four compact fields:

| Field | SAS type | Meaning |
| --- | --- | --- |
| `media_sha256` | String | Lowercase SHA-256 digest of exact media bytes |
| `manifest_sha256` | String | SHA-256 digest of the canonical public manifest |
| `statement_type` | String | `creator_media_commitment_v1` |
| `version` | U8 | `1` |

The CLI verifier fetches credential, schema, and attestation accounts; checks
SAS ownership and PDA/account relationships; verifies signer roles, schema
status/shape, and expiry; decodes the payload; and can recompute both local
commitments. This live CLI verification is separate from the current offline
browser verifier.

## Creator-first, sponsor-last policy

`src/sponsor-policy.ts` is the authoritative sprint sponsorship design. It is an
offline policy/state-machine core, not an HTTP endpoint.

1. The service strictly parses a canonical issue request, checks the connected
   creator against a fixed allowlist, derives pinned SAS accounts, and builds a
   transaction whose creator and sponsor signature slots are both empty.
2. The external creator wallet signs those exact message bytes first.
3. The server validates the creator signature and immutable plan, rechecks one
   pinned Devnet context, verifies credential/schema authority, quotes the exact
   fee and rent, and simulates without replacing the blockhash.
4. A durable store must atomically enforce idempotency, freshness, creator
   quota, sponsor balance floor, and cumulative budget before signing.
5. A server-only sponsor fills only its own signature slot last. Fully signed
   wire is retained for a separate server broadcast worker and is never returned
   by the public begin/complete results.

The included `InMemorySponsorPolicyStore` models atomic transitions, exact-cost
reservations, fenced signing leases, replay, and reconciliation for offline
tests. It is not durable and must not be deployed.

`src/sponsored-attestation.ts` is the neutral canonical wire decoder and
semantic validator reused by the policy. It intentionally exports no builder or
signature-sequencing workflow; creator-first/sponsor-last ordering belongs only
to the policy service.

## Explicit production boundary

Before sponsorship can be deployed, separate reviewed adapters must provide:

- transaction-review, signing, and account-snapshot binding on top of the
  connection-only Wallet Standard readiness UI;
- authenticated HTTP request/body limits and per-IP or per-session rate limits;
- provisional-plan TTL cleanup, global issuance limits, and storage caps;
- one private pinned Devnet RPC client with genesis/min-context discipline;
- a durable transactional database implementing the reference state machine;
- isolated sponsor secret loading and signing;
- server-only broadcast, confirmation, non-landing reconciliation, and crash
  recovery; and
- operational monitoring and emergency budget shutdown.

These are deployment blockers, not implied capabilities of the offline core.
Neither this design nor the baseline is Mainnet production readiness, C2PA
compliance, legal ownership proof, identity verification, or a universal
revocation system.

## Velorn isolation boundary

This repository is not a Velorn workspace package, submodule, runtime
dependency, or linked directory. No code here is loaded by the released Velorn
desktop application. Any opt-in desktop reference flow is developed in a clean,
isolated Velorn worktree and must pass Velorn's normal review before merge or
release.
