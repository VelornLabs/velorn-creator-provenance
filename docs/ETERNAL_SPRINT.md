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

## Week 2 creator-paid issuer

The public Week 2 issuer removes the local sponsor dependency from the hosted
path. Opening a public issue link remains inert. The page must first prove an
exact local byte match, then expose separate explicit clicks for wallet
connection, transaction preparation, public review, and signing.

The reviewed transaction is one atomic creator-paid Devnet transaction that
creates a proof-scoped SAS credential, schema, and attestation. The creator pays
the Devnet transaction fee and rent-exempt deposits for all three accounts in
Devnet SOL. The hosted page has no media upload, application server, embedded
private key, or gas sponsor.

After wallet signing, the page derives the transaction signature embedded in
the signed wire and its SHA-256 digest. Immediately before it sends that exact
wire with the prepared `minContextSlot`, it adds a public status record to a
bounded canonical same-origin store. The store holds at most eight records
keyed by request binding and never retains the raw wire.

All store operations are serialized with browser Web Locks and issuance fails
closed if safe coordination is unavailable. Clearing is a per-record
compare-and-clear. Unresolved records are not deleted based only on wall-clock
age, while finalized records remain until explicit clear or durable handoff.
An unsuccessful or absent attempt is safe to retry only after finalized
blockhash invalidity and an account-absence read anchored at least to that
blockhash response context.
Reload recovery checks the derived signature and never signs, sends, resubmits,
or rebroadcasts. The stored request-wallet-transaction correlations are public
and readable to same-origin scripts and people with access to the browser
profile.

After finality, recovery fetches the signed transaction bytes from the fixed
RPC, matches their saved digest, reconstructs the exact request plan, and
revalidates the instructions and creator signature. Only then does that one
transaction signature fill all three creation references in the canonical v1
receipt, because the same atomic transaction created all three accounts.

Proof-scoped credentials keep that receipt evidence self-contained. They cost
more rent than a reusable creator credential/schema; reusable identity is a
future history/indexing or receipt-version design problem, not a shortcut for
this sprint. The resulting receipt remains a wallet assertion about exact bytes
and is not copyright, ownership, identity, originality, permission, or truth
proof.

## September 6 acceptance evidence

The local production build completed the creator-paid flow with Phantom:
one atomic transaction finalized, all 29 live verifier checks passed, and the
same exported MP4 matched independently in the verifier. The exact public
receipt and reproducible link are preserved in
[`evidence/eternal-creator-paid-proof-2026-09-06`](../evidence/eternal-creator-paid-proof-2026-09-06/README.md).
An expired unsigned quote was rejected before signing; the subsequent refresh
UX now offers a direct refresh action and returns to review without signing.

The isolated desktop export handoff already produced the request used in this
run. Next product work is the optional public creator profile and
contact-for-hire experience, followed by external creator/developer feedback.
Hosted receipt verification and hosted wallet issuance must be reported as
separate checks; the local wallet run does not prove the hosted origin's wallet
flow. See the runbook for the publication smoke check.

## Explicitly outside this sprint

No token, marketplace, payments, escrow, Mainnet launch, Nosana integration,
hosted media, identity verification, production C2PA certificate, or universal
revocation system is promised in this four-week build.
