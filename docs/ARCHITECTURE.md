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
- makes no Solana request on link open, then offers a separately disclosed,
  explicit-click live check against the fixed public Devnet RPC.

The public browser slice includes both a read-only verifier and a creator-paid
Devnet issuer. It has no upload, analytics, application-server API, embedded
private key, or gas sponsor. Its fixed RPC paths are the explicit read-only
verification action and the separately reviewed preparation, send, and status
operations for issuance; media bytes, filenames, and local paths never enter
those requests. Deterministic home-page examples are synthetic UI fixtures and
are never sent to RPC as chain evidence.

A public `#issue/v1` page is inert on open. It first hashes a user-selected file
locally and requires an exact match with the request commitment. Wallet
connection, transaction preparation, review, and signing are distinct explicit
actions. Preparing displays the fixed public accounts, commitment, expiry, and
creator cost without signing or sending. The final action asks Phantom to sign
only after that review.

A separate entry point, used only by `npm run dev:devnet`, provides the guided
local Devnet test harness. It is pinned to `127.0.0.1:4173`, remains inert until
the user explicitly starts a session, and keeps local media bytes in the
browser. It uses a creator-first wallet signature and a server-only disposable
sponsor signature. That entry is never used by the normal static preview or
production web build.

## Public static hosting boundary

The public verifier's canonical deployment target is
[`https://velornlabs.github.io/velorn-creator-provenance/`](https://velornlabs.github.io/velorn-creator-provenance/).
The repository owner must enable Pages with **GitHub Actions** as its source
before the first deployment; the least-privilege branch workflow does not
self-enable repository Pages settings.
The Pages artifact is limited to `dist/web`: the static browser application and
its assets. It does not publish the loopback Devnet harness, sponsor service,
private keys or other secrets, or any media-upload endpoint. The public build
can discover a compatible wallet and run the explicit creator-paid issuer. The
wallet extension retains the creator key; the static application receives only
the signed transaction bytes needed for exact validation and immediate Devnet
broadcast and does not persist those bytes.

Shareable receipt data is transported after `#verify/v1/`. The URL fragment is
not included in the HTTP request sent to GitHub Pages, so GitHub does not need
the receipt to serve the verifier shell. The fragment remains readable to the
recipient and to software with access to the full URL, including browser or
synced history, clipboard tools, and extensions. It must therefore contain
only intentionally public receipt fields. Loading the shell and decoding the
fragment are offline operations. A live check occurs only after the visitor
selects the clearly labeled action, and that action performs read-only queries
against the fixed Solana Devnet RPC.

During the isolated sprint review, the Pages workflow uses
`codex/eternal-sprint` as its temporary deployment source. Publication can move
to the default branch after review; that transition is not implied by the
prototype. The repository-scoped Pages address is the canonical sprint URL,
while a custom domain remains an optional later hosting choice and does not
alter the fragment or receipt formats.

## Hosted creator-paid issuance boundary

The Week 2 hosted issuer avoids a browser-shipped sponsor secret and avoids
depending on an application server. After the exact-byte gate, its deliberate
sequence is:

1. connect a compatible Wallet Standard account on Devnet;
2. prepare one fixed legacy transaction using a recent blockhash and pinned
   SAS/compute-budget instructions;
3. review the public commitment, proof-scoped account addresses, expiry, three
   rent-bearing account creations, and creator-paid Devnet SOL cost; and
4. explicitly ask the wallet to sign, validate the exact returned wire, derive
   its embedded transaction signature and SHA-256 digest, and send that exact
   wire to the fixed Devnet RPC with the prepared `minContextSlot`.

The transaction creates a new proof-scoped SAS credential, schema, and
attestation atomically. The creator is fee payer, credential authority,
authorized signer, and attestation signer. The browser supplies only no-op
signer metadata while constructing instructions; Phantom owns the private key
and supplies the actual signature. No media bytes, filename, local path, wallet
metadata, seed, private key, or arbitrary transaction target enters storage or
the network request.

One transaction means one finalized signature is the honest creation reference
for all three accounts in the existing v1 receipt. Once finality and the fetched
SAS accounts are validated, receipt assembly uses that signature for the
credential, schema, and attestation transaction fields. The receipt still
represents a wallet assertion about exact bytes, not copyright or identity
proof.

Immediately before the external send boundary, the issuer adds a record to a
bounded, versioned, canonical same-origin recovery store. It contains at most
eight public status records keyed by canonical request ID/hash binding. Each
record contains the creator, proof-scoped public accounts and credential name,
signature derived from the signed wire, signed-wire digest, blockhash
lifetime/`minContextSlot`, public expiry, and creation time. It contains no raw
wire and therefore cannot sign, send, resubmit, or rebroadcast.

Every recovery-store read, write, update, and clear is serialized with the
browser Web Locks API. If that coordination primitive or safe access to the
same-origin store is unavailable, the issuer fails closed before sending.
Clearing is per-record compare-and-clear: it removes only the exact record that
still matches the caller's observed binding and transaction facts, never a
newer replacement from another tab. Retry clearing additionally requires the
fixed RPC to report the saved recent blockhash invalid at finalized commitment,
then report all three intended accounts absent from a finalized account read
whose `minContextSlot` is the blockhash-validity response context.

Reload recovery queries status for the derived embedded signature. After
finality it reconstructs the deterministic plan, fetches the finalized signed
transaction bytes from the fixed RPC, matches their saved SHA-256 digest, and
runs the same exact-wire and creator-signature validator before receipt
assembly. An unresolved record is never discarded
solely because wall-clock time passed; when the eight-record bound cannot be
satisfied safely, new issuance fails closed rather than evicting unresolved
evidence. Finalized records remain until explicit clear or a durable receipt
handoff. Structurally corrupt, non-canonical, or internally mismatched store
data is not acted upon.

The recovery data is public but correlating: it links a canonical request to a
creator wallet, SAS accounts, and transaction signature. Any script executing
on the same origin, or any person with access to the browser profile, can read
those correlations. Same-origin storage is a recovery boundary, not a privacy
or secret-storage boundary.

Proof-scoped credentials make the v1 creation evidence self-contained and
avoid relying on unavailable historical creation signatures for reused SAS
accounts. The tradeoff is three new rent-bearing accounts for every proof. A
reusable creator credential/schema would reduce repeated rent but needs a
durable history/indexing design or a future receipt contract that can represent
pre-existing verified accounts without fabricating creation references.

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

The shared live-chain verifier fetches credential, schema, and attestation
accounts; checks SAS ownership and PDA/account relationships; verifies signer
roles, schema status/shape, and expiry; and decodes the payload commitment. The
CLI adds optional local-media/manifest recomputation. The browser invokes only
the read-only chain portion after an explicit click and keeps its local byte
comparison independent.

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

## Local sprint harness and production boundary

The sprint harness composes reviewed, narrow reference adapters for loopback
HTTP, Wallet Standard signing, hard-pinned Devnet reads, exact fee/rent
simulation, sponsor-last signing, exact-wire broadcast, and finalized-status
recovery. Each browser request is a fixed semantic operation; there is no
arbitrary RPC, program, instruction, transfer, signing, or broadcast endpoint.
The final sponsor-signed wire remains server-side.

The local server uses one process, one browser session, one creator binding,
one-shot budgets, an ignored disposable Devnet sponsor file, and in-memory
state. Those restrictions make it useful for a bounded sprint demonstration;
they do not make it deployable.

After finalized confirmation, the flow derives one canonical shareable receipt
from its retained canonical request and finalized enrollment/attestation
evidence, caches it idempotently, and returns it only in the confirmed status.
The browser cannot submit replacement receipt fields. The assembly time is
labeled as service receipt time rather than an on-chain timestamp.

Before sponsorship can be deployed, separate reviewed adapters must provide:

- production-grade transaction review and recovery UX rather than the local
  guided harness;
- authenticated public HTTP ingress and per-IP, per-session, and global rate
  limits;
- provisional-plan TTL cleanup, global issuance limits, and storage caps;
- a durable transactional database implementing the reference state machine;
- managed production signing keys rather than the local file-backed disposable
  Devnet sponsor;
- durable server broadcast, confirmation, non-landing reconciliation, and
  crash recovery across processes; and
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
