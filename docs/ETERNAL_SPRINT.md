# Colosseum Eternal Sprint

Velorn Creator Provenance entered the 2026 Colosseum Eternal challenge on
August 27, 2026 at 17:45:16 UTC. The four-week submission deadline is
September 24, 2026 at 17:45:16 UTC.

## Disclosed baseline

All work completed before the challenge is frozen at the annotated tag
[`eternal-2026-pre-sprint`](https://github.com/VelornLabs/velorn-creator-provenance/tree/eternal-2026-pre-sprint),
which resolves to commit `63446b750ab8b6178fd6d94197e4f29353c87b35`.
That baseline already demonstrates SAS Devnet issuance, deterministic media
commitments, public receipt verification, automated tests, and reproducible
chain evidence. Those capabilities are prior work and will not be represented
as Eternal sprint work.

The judged sprint work begins on branch `codex/eternal-sprint`.

## Product goal

Velorn Creator Provenance lets a video creator review an exact local media
commitment, approve a public Solana Attestation Service receipt with an
external wallet, and share a verifier link. Another person can select the media
file locally and verify its bytes without uploading the file. An optional
wallet-signed profile can link discovered work to the creator's portfolio or
contact-for-hire page.

The receipt is a wallet assertion about exact bytes. It is not proof of legal
identity, authorship, copyright ownership, or truth.

## Four-week target

1. Build a browser-wallet issuer and static local-file verifier on Devnet.
2. Add an opt-in reference flow to a clean, isolated Velorn feature worktree.
3. Polish the creator profile and contact-for-hire verification experience.
4. Test with ten creators and two independent developers, document results,
   and deliver the required weekly and final demonstrations.

Media, prompts, private keys, and seed phrases must never be uploaded or placed
on-chain. The production Velorn application will not be merged or released as
part of the challenge without its normal review process.

## Week 1 acceptance test

- Connect one supported external Wallet Standard wallet on Solana Devnet.
- Keep the creator wallet as the SAS authority and attestation signer.
- If fee sponsorship is viable, use a separate tightly constrained Devnet fee
  payer that cannot sign arbitrary transactions.
- Issue a receipt for a fixture through the browser flow.
- Open a shareable verifier page and validate the live SAS accounts.
- Hash the selected fixture locally and show a clear match.
- Change one byte and show a clear failure.
- Reject malformed links, the wrong cluster, and an unexpected schema.
- Deploy a public preview and record the first one-minute progress update.

## Explicitly outside this sprint

No token, marketplace, payments, escrow, Mainnet launch, Nosana integration,
hosted media, identity verification, production C2PA certificate, or universal
revocation system is promised in this four-week build.
