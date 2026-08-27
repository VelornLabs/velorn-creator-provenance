# Devnet runbook

## Local gate

```bash
npm ci
npm test
npm run build
```

These commands do not broadcast transactions.

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
