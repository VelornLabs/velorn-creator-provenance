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

- Media and manifest contents remain local; only SHA-256 hashes and a short statement identifier go on-chain.
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

- Node.js 22 or later
- Network access to Solana Devnet

The Solana CLI and Rust toolchain are not required for this TypeScript Devnet flow.

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

Apache-2.0. The package is marked `private` only to prevent accidental npm publication during Phase 0; the source remains licensed for reuse. The Velorn name and logo are not licensed for uses that imply affiliation or endorsement; see `NOTICE`.
