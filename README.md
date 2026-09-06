# Velorn Creator Provenance PoC

This is an isolated proof of concept for committing media and provenance-manifest hashes to the [Solana Attestation Service](https://attest.solana.com/) on Devnet.

It lives in its own repository, has its own dependencies, and does **not** modify or run the Velorn desktop application. No code from this prototype is loaded by Velorn.

The current four-week Colosseum build, its disclosed pre-sprint baseline, and
its acceptance criteria are recorded in
[`docs/ETERNAL_SPRINT.md`](docs/ETERNAL_SPRINT.md).

## What the proof demonstrates

1. Hash local media bytes and a canonical provenance manifest with SHA-256.
2. Create a creator-controlled Solana Attestation Service credential and schema on Devnet.
3. Issue an attestation containing only those hashes, a narrowly worded statement type, and a schema version.
4. Fetch the public accounts back from Devnet and verify the account relationships, expiry, and hash commitments.
5. Save a public receipt containing addresses, transaction signatures, and Explorer links—never private keys.

The on-chain record proves that a particular Solana signer made a commitment to specific bytes. It does **not** by itself prove copyright ownership, factual authorship, or that a creative work is truthful. A production version should combine this receipt with C2PA Content Credentials, clear legal terms, identity choices, and a deliberately designed revocation/supersession convention; SAS does not provide that complete lifecycle automatically.

## Safety and privacy

- Media bytes remain local in the browser and are never placed in a provenance link. Only the compact SHA-256 commitments, statement identifier, and schema version are written into the SAS attestation.
- The `#issue/v1` and `#verify/v1` links intentionally contain opted-in public manifest metadata, lifecycle data, creator profile URLs, and receipt evidence. Sharing one sends those fields to the recipient, and browser or clipboard history may retain the link; URL encoding is not encryption.
- A public issue page is inert when opened. It cannot connect a wallet, contact
  Devnet, prepare, sign, or send until the user takes the separately labeled
  actions, and issuance remains disabled until a locally selected file passes
  the exact-byte hash check.
- Opening a verifier link makes no Solana request. A separate explicit live-check action contacts only the fixed public Devnet RPC; that provider can observe the visitor's IP/origin and the public addresses/signatures being queried, but receives no media bytes, filename, or local path.
- Hosted issuance has no upload or application-server path and no embedded
  private key or gas sponsor. Phantom holds the creator key, while the static
  page sends only the approved signed transaction to the fixed Devnet RPC.
- Immediately before that send, the page writes to a bounded, canonical
  same-origin recovery store containing at most eight public status records,
  keyed by canonical request binding. Recovery checks status for the derived
  embedded signature and never stores transaction wire or signs, resubmits, or
  rebroadcasts a transaction. Store operations are serialized with browser Web
  Locks; issuance fails closed if safe coordination is unavailable. The stored
  request-wallet-transaction correlations are public and readable to other
  same-origin scripts and to people with access to the browser profile.
- The default Devnet attempt creates disposable in-memory keypairs. The optional reusable-wallet command stores one **Devnet-only** seed in the ignored `.local/` directory with mode `0600`; neither path prints the secret or includes it in a receipt.
- Do not use a real wallet or real funds with this proof of concept.
- `artifacts/` is ignored because receipts are run-specific. A receipt contains public information only.
- A sanitized receipt from the canonical successful Devnet run is preserved in [`evidence/`](evidence/DEVNET_PROOF.md); it contains public chain data only.
- The first complete browser-wallet and separately sponsored Devnet proof is preserved in [`evidence/eternal-wallet-proof-2026-08-28/`](evidence/eternal-wallet-proof-2026-08-28/README.md). Its receipt was reconstructed from finalized public records because the guided harness did not yet export one automatically.
- The fixture provenance statement is a deterministic stand-in for future C2PA integration; it is not presented as a valid C2PA manifest.
- Dependency versions are pinned to the latest stable SAS 1.x client used by Solana Foundation's pre-breaking TypeScript example. The current SAS 2.x client is still published as a beta.
- The local harness uses a 365-day expiry to exercise verifier expiry handling. The hosted creator-paid issuer generates and reviews a 30-day expiry for each transaction. Neither is a proposed production retention policy.

## Public-good intent and why Solana

The grant-funded target is an Apache-licensed schema/specification, TypeScript SDK, issuer CLI, independent verifier, test vectors, documentation, maintenance, and adoption work that any editor or media tool can use without a Velorn account or paid Velorn service. Velorn would be the first reference client and distribution path, not a required gatekeeper.

A signed JSON file could prove a signature locally, and a centralized database could index receipts. Solana adds a shared public account layer through SAS's credential/schema/attestation model, wallet-native verification, inexpensive repeated writes, and composability with future USDC creator payments and revenue splits. The prototype will measure those properties rather than claiming that a blockchain alone establishes ownership.

The proposed standard grant would fund only that reusable open-source public-good layer. Velorn's future paid cloud-generation service, marketplace operations, moderation, hosted indexing, and commercial support are outside this PoC and outside the standard-grant deliverables.

## Requirements

- Node.js 22.12 or later
- Network access to Solana Devnet for issuance, CLI verification, or the optional explicit browser live check

The static browser shell and local byte checker do not require Solana network
access after their dependencies are installed. Only explicit verification or
issuer actions contact Devnet. The Solana CLI and Rust toolchain are not
required for the TypeScript Devnet flow.

## Browser preview and public issuer

The Eternal sprint browser has a strict `#issue/v1` request parser, a strict
`#verify/v1` receipt parser, and incremental local-file SHA-256 checking:

```bash
npm run dev:web
```

Opening an issue page is preview-only and performs no wallet or network action.
After the selected file produces the exact requested hash, the hosted issuer
uses separate explicit clicks to connect the wallet, prepare a fixed Devnet
transaction, review its public fields and costs, and request the signature.
Preparation is still read-only. Only the final reviewed signing action permits
the already-specified transaction to be signed and sent.

The final transaction is creator-paid and atomic: it creates a proof-scoped SAS
credential, schema, and attestation together. All three accounts require
rent-exempt deposits, and the creator wallet pays those deposits plus the
Devnet transaction fee in Devnet SOL. There is no server, media upload, embedded
key, or gas sponsor in this hosted path. Use only a disposable or test-mode
Phantom account funded with a small amount of Devnet SOL.

On a real receipt, the verifier offers a separate explicit-click, read-only
Devnet check against the fixed public RPC. Selected files are read in bounded
chunks and remain on the device, and the static application has no upload path
or analytics. Build the deployable files with `npm run build:web`.

The home page includes deterministic synthetic links for both routes, so a
reviewer can exercise the UI without constructing a payload. Those links use
placeholder accounts and signatures and are **not chain evidence**. Select
`fixtures/sample-export.txt` in either sample route to see the expected local
hash match; changing one byte produces a mismatch.

## Public verifier hosting

The canonical deployment target for the static verifier is
[`https://velornlabs.github.io/velorn-creator-provenance/`](https://velornlabs.github.io/velorn-creator-provenance/).
Before the first deployment, a repository administrator must enable GitHub
Pages with **GitHub Actions** as its source; the branch workflow cannot enable
Pages with its limited token.
GitHub Pages receives only the built `dist/web` files. That public artifact does
not include the local Devnet harness, sponsor service, secrets, or a
media-upload path. It does include the creator-paid Wallet Standard issuer, but
the wallet extension retains the private key and every issue page is inert on
open. A visitor can inspect a transported receipt and hash a candidate file
locally without connecting a wallet.

Receipt data follows `#verify/v1/` in the URL fragment. Browsers do not send that
fragment to GitHub Pages as part of the page request, but the fragment is still
readable information—not a secret. The recipient, browser history, synced
history, clipboard tools, or installed extensions may retain it. Opening the
link performs no chain request; the only network verification is a separately
labeled, explicit-click, read-only query to the fixed Solana Devnet RPC.

For this isolated sprint checkpoint, `codex/eternal-sprint` is the temporary
Pages deployment source while the work is reviewed. Moving publication to the
default branch is a later, deliberate repository change. The GitHub Pages URL
is sufficient for the sprint; a custom domain can be added later without
changing the receipt contract.

## Hosted creator-paid Devnet issuance

The hosted Week 2 path intentionally uses one new credential and schema for
each proof. After an exact local byte match and the separate
connect/prepare/review/sign checkpoints, one creator-paid transaction creates
the credential, schema, and attestation atomically. Either the transaction
lands with all three accounts or none of them are created.

The proof-scoped credential name is exactly 32 ASCII bytes: `VELORN-` followed
by 25 uppercase RFC 4648 base32 characters (125 binding bits) derived from the
canonical request and creator address.

Because one finalized transaction contains all three creation instructions,
its same signature truthfully fills the v1 receipt references for credential,
schema, and attestation creation. The page then assembles the canonical public
receipt and verifier link from the original request and finalized public chain
facts. This avoids inventing missing creation history for a previously reused
credential.

The tradeoff is cost: every proof creates three rent-bearing SAS accounts
instead of amortizing one reusable creator credential and schema over many
attestations. A future reusable-credential design needs durable, independently
verifiable creation-history recovery or a new receipt version before it can
retain the same evidence guarantees.

After wallet signing, the browser derives the transaction signature embedded in
the exact signed wire and computes that wire's SHA-256 digest. Immediately
before sending the exact wire with the prepared `minContextSlot`, it adds a
canonical public record to a same-origin recovery store. The store holds at
most eight records, keyed by canonical request ID/hash binding, and contains no
raw signed wire, media bytes, filenames, paths, wallet metadata, URLs, or
private keys.

All recovery-store operations are serialized with browser Web Locks. If safe
same-origin coordination is unavailable, the issuer fails closed instead of
sending. Reload recovery can check the derived signature, reconstruct the exact
plan, fetch the finalized signed transaction from the fixed RPC, match its wire
digest, and cryptographically revalidate its instructions and creator signature
before reconstructing a receipt. It cannot sign, send, resubmit, or rebroadcast. Unresolved
records are not deleted based only on wall-clock age, and finalized records
remain until an explicit per-record compare-and-clear or a durable handoff.
Compare-and-clear removes only the exact record the caller observed, not a
newer replacement. A failed or absent attempt becomes retry-clearable only
after the fixed RPC reports its recent blockhash invalid at finalized
commitment and a subsequent finalized account read, anchored at least to that
response context, finds all three intended accounts absent. If all eight slots contain unresolved records, a new send
must wait for explicit resolution rather than silently evicting evidence.

These stored request, wallet address, and transaction correlations are public,
not secret. Any script executing on the same origin, or any person with access
to the browser profile, may read them.

This remains a wallet assertion about exact bytes, not proof of copyright,
legal ownership, identity, originality, permission, or truth.

## Local Devnet guided harness

The Eternal sprint also includes a separate, deliberately local-only guided
test harness:

```bash
npm run dev:devnet
```

This is **not** the ordinary public preview. It is bound to exactly
`http://127.0.0.1:4173`, uses a hard-pinned Solana Devnet RPC endpoint and SAS
program, and loads the ignored disposable sponsor from
`.local/devnet-payer.json` inside the Node process. It cannot be built or
previewed as a deployable site. The browser receives only fixed semantic plans
and creator-unsigned transaction bytes; it never receives the sponsor secret or
the final sponsor-signed transaction.

Nothing happens merely by opening the page. Each network step and each Phantom
request requires an explicit action after a visible review. The selected
creator account pays Devnet-only network fees and rent-exempt account deposits
for its one-time credential/schema enrollment; the disposable sponsor pays the
later attestation fee and account deposit. Use only a disposable or test-mode
Phantom account with a small Devnet balance. Never use Mainnet SOL, import the
local sponsor seed into a browser wallet, or treat this harness as production
infrastructure.

If a confirmation response is delayed or lost, use the page's explicit status
check. It checks the already-signed transaction and never signs, resubmits, or
rebroadcasts it.

After finalized confirmation, the service assembles and caches one canonical
public receipt from its retained request and finalized enrollment/proof records.
Only the confirmed status can return that receipt. The page then offers an
explicit verifier link and the canonical JSON; it never auto-opens, auto-copies,
or includes the media, filename, local path, wallet metadata, private keys, or
signed transaction wire.

## Public-wire contract boundary

The ordinary v1 parse/serialize functions preserve the broader published v1
compatibility envelope, including insignificant JSON formatting differences and
some historically permitted nested properties. They are not the public-wire
trust boundary. New wallet handoffs and share links use
`serializeCanonicalProvenanceRequestJson`,
`serializeCanonicalShareableProvenanceReceiptJson`, and their matching strict
canonical parsers. Fragment transport has its own 6,000-byte cap, independent
of the general 64 KiB v1 JSON limit.

## Creator-first sponsorship reference

`src/sponsor-policy.ts` is an offline creator-first/sponsor-last policy core.
Stage one returns a canonical transaction with both signature slots empty. The
creator approves those exact bytes first; only after strict validation, pinned
Devnet revalidation, and atomic exact-cost reservation may a server-only sponsor
fill its slot. Final signed wire remains server-side for a separate broadcast
worker and is never returned by the public service result.

This repository now contains a loopback-only HTTP harness, guided Devnet review
and signing UI, hard-pinned Devnet adapters, exact-wire broadcast/confirmation,
and an in-memory reference state machine for the sprint demonstration. It does
**not** contain a production HTTP service, durable transactional store, real
authentication or abuse controls, provisional-plan cleanup, multi-process
leases, production secret management, operational monitoring, or long-running
reconciliation workers. The local harness is not a deployable sponsorship
backend. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete boundary.

## Run locally

```bash
npm install
npm test
npm run build
npm run devnet
```

If the public Devnet faucet is rate-limited, the local tests and build can still pass; retry the network demo later or use a separately funded disposable Devnet payer. Faucet failure is an external availability issue, not a reason to use a valuable wallet.

To prepare a reusable **Devnet-only** wallet for manual funding when the programmatic faucet is rate-limited:

```bash
npm run prepare:devnet-wallet
```

This writes `.local/devnet-payer.json` with mode `0600` and prints only its public address. The entire `.local/` directory is gitignored. Use that address only with a Devnet faucet; never send real SOL or reuse a Mainnet wallet. The demo automatically loads this file when present.

After a successful run:

```bash
npm run verify -- artifacts/devnet-receipt.json \
  fixtures/sample-export.txt \
  fixtures/sample-provenance-manifest.json
```

The first successful public proof and its independently verified receipt are documented in [`evidence/DEVNET_PROOF.md`](evidence/DEVNET_PROOF.md).

Optional endpoints:

```bash
SAS_RPC_URL=https://api.devnet.solana.com \
SAS_WSS_URL=wss://api.devnet.solana.com \
npm run devnet
```

## License

Apache-2.0. The package is marked `private` to prevent accidental npm publication during the PoC; the source remains licensed for reuse. The Velorn name and logo are not licensed for uses that imply affiliation or endorsement; see `NOTICE`.
