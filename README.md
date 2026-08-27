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
- The default Devnet attempt creates disposable in-memory keypairs. The optional reusable-wallet command stores one **Devnet-only** seed in the ignored `.local/` directory with mode `0600`; neither path prints the secret or includes it in a receipt.
- Do not use a real wallet or real funds with this proof of concept.
- `artifacts/` is ignored because receipts are run-specific. A receipt contains public information only.
- A sanitized receipt from the canonical successful Devnet run is preserved in [`evidence/`](evidence/DEVNET_PROOF.md); it contains public chain data only.
- The fixture provenance statement is a deterministic stand-in for future C2PA integration; it is not presented as a valid C2PA manifest.
- Dependency versions are pinned to the latest stable SAS 1.x client used by Solana Foundation's pre-breaking TypeScript example. The current SAS 2.x client is still published as a beta.
- The PoC uses a 365-day expiry so the verifier exercises explicit expiry handling. Choosing a durable production lifecycle is funded design work, not a claim made by this demo.

## Public-good intent and why Solana

The grant-funded target is an Apache-licensed schema/specification, TypeScript SDK, issuer CLI, independent verifier, test vectors, documentation, maintenance, and adoption work that any editor or media tool can use without a Velorn account or paid Velorn service. Velorn would be the first reference client and distribution path, not a required gatekeeper.

A signed JSON file could prove a signature locally, and a centralized database could index receipts. Solana adds a shared public account layer through SAS's credential/schema/attestation model, wallet-native verification, inexpensive repeated writes, and composability with future USDC creator payments and revenue splits. The prototype will measure those properties rather than claiming that a blockchain alone establishes ownership.

The proposed standard grant would fund only that reusable open-source public-good layer. Velorn's future paid cloud-generation service, marketplace operations, moderation, hosted indexing, and commercial support are outside this PoC and outside the standard-grant deliverables.

## Requirements

- Node.js 22.12 or later
- Network access to Solana Devnet for the CLI issuance/verifier flow

The static browser preview does not require Solana network access after its
dependencies are installed. The Solana CLI and Rust toolchain are not required
for the TypeScript Devnet flow.

## Browser preview

The first Eternal sprint browser slice has a static `#issue/v1` request
preview, a strict `#verify/v1` link parser, and incremental local-file SHA-256
checking:

```bash
npm run dev:web
```

The preview can now discover and explicitly connect a compatible Wallet
Standard extension for a connection-only Devnet readiness check. It does not
request a signature, prepare or send a transaction, contact an RPC endpoint, or
issue an attestation. It has no upload path or analytics; selected files are
read in bounded chunks and remain on the device. Build the deployable static
files with `npm run build:web`.

The home page includes deterministic synthetic links for both routes, so a
reviewer can exercise the UI without constructing a payload. Those links use
placeholder accounts and signatures and are **not chain evidence**. Select
`fixtures/sample-export.txt` in either sample route to see the expected local
hash match; changing one byte produces a mismatch.

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

This repository does not yet contain the production HTTP service, wallet
transaction-review/signing UI, pinned RPC adapter, durable transactional store,
broadcast worker, authentication/rate limits, provisional-plan cleanup, or
reconciliation workers. The included in-memory store is an offline
state-machine reference, not a deployable sponsorship backend. See
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
