# Devnet runbook

## Local gate

```bash
npm ci
npm test
npm run build
```

These commands do not broadcast transactions.

## Public verifier publication gate

Build the static browser artifact with:

```bash
npm run build:web
```

Before the first Pages deployment, a repository administrator must select
**GitHub Actions** as the Pages source in the repository settings. The
least-privilege branch workflow cannot enable Pages itself and will fail closed
until this one-time gate is complete.

GitHub Pages then publishes only `dist/web` at
[`https://velornlabs.github.io/velorn-creator-provenance/`](https://velornlabs.github.io/velorn-creator-provenance/).
It does not publish or run the local Devnet harness, sponsor service, secrets,
or a media-upload endpoint. The Week 2 static issuer asks the external wallet
for a signature only after local media verification and explicit review and
approval. During this isolated checkpoint,
`codex/eternal-sprint` is the temporary deployment source pending review; moving
the source to the default branch is a separate follow-up. A custom domain is
optional and is not required for verification.

## Week 2 smoke and review

The September 6 local-production browser run is recorded in
[`evidence/eternal-creator-paid-proof-2026-09-06`](../evidence/eternal-creator-paid-proof-2026-09-06/README.md).
It covers an expired quote rejected before signing, a refreshed quote, one
Phantom approval, finality, all 29 verifier checks, and a matching local MP4.

If a reviewed transaction expires before signing, choose **Refresh transaction**.
This obtains a fresh blockhash, repeats the account, balance, fee and simulation
checks, and returns to review. Read the updated cost and expiry, then approve
separately. Refreshing never signs or submits. An attempt already saved for
recovery must instead use the status-check flow; it must never be refreshed
into a second send.

After publication, open the preserved receipt using the public Pages URL and
choose **Check live Solana Devnet**. Select the original MP4 locally to confirm
its hash again. This verifies the deployed receipt path without creating a new
transaction. Testing issuance itself from the hosted origin requires a separate
user-approved wallet run and is distinct from this read-only deployment check.

A `#verify/v1/` receipt fragment is not sent to GitHub Pages in the HTTP page
request, but it is readable by the recipient and may remain in browser or
synced history, clipboard tools, or extensions. Treat every transported field
as public. Loading a receipt makes no RPC request. The verifier contacts only
the fixed Solana Devnet RPC, read-only, after the visitor explicitly selects the
live-check action; media bytes remain on the device.

## Prepare a disposable wallet

```bash
npm run prepare:devnet-wallet
```

The command creates `.local/devnet-payer.json`, refuses to overwrite an existing file, applies mode `0600`, and prints only the public address. `.local/` is gitignored. Never use a Mainnet wallet, seed phrase, or real SOL.

## Fund and run

First try the programmatic Devnet path:

```bash
npm run devnet
```

If the public RPC faucet is rate-limited, fund the printed public address using an approved Devnet-only method and rerun the same command. The script checks the observed Devnet genesis hash before any write and skips the airdrop when the saved wallet already has enough Devnet SOL.

## Verify independently

```bash
npm run verify -- artifacts/devnet-receipt.json \
  fixtures/sample-export.txt \
  fixtures/sample-provenance-manifest.json
```

The verifier exits nonzero when any chain/account/hash check fails. Without the two fixture paths it verifies the public chain receipt only and does not claim that local media bytes were checked.
