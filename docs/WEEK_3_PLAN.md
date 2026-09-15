# Week 3 starting point

## Local implementation — September 11, 2026

The first increment is implemented in the provenance repository. The September
15 manual checkpoint below records a profile-bearing Devnet proof; publication
of the updated interface is tracked separately from that chain result.
Main Velorn and the isolated desktop export integration are unchanged.

- Real `#issue/v1` requests have a collapsed optional profile form before the
  file check. The default is no profile; existing profile requests are editable.
- Opt-in fields: display name, HTTPS portfolio URL, and HTTPS contact-for-hire
  URL. The form shows the exact normalized values before creating a new link.
- Drafts are memory-only. Cancel/closing discards draft changes. Preparing the
  new review changes the request ID and recalculates the manifest commitment;
  the media hash, original media declaration, and lifecycle are retained.
- Opening the editor cancels/reset local hashing and hides the current request
  and issuer. Editing is hidden after an exact match, so it cannot silently
  change the request during wallet review/signing. A newly reviewed link must
  match the file again before exposing wallet steps.
- Synthetic sample requests and lifecycle actions other than `issue` do not
  expose the editor. Receipt pages are always read-only.
- Verifiers show the asserted profile, claimed signer, local-file check, and
  explicit live-chain check before detailed evidence. Profile links use HTTPS,
  no embedded credentials, and new tabs with no opener/referrer. Names remain
  text, not HTML. Both stages distinguish profile assertions from identity.
- New profiles are bounded to 1,024 UTF-8 JSON bytes to leave room for receipt
  evidence in the existing bounded fragment transport.

Local validation: 329 tests passed; core and web builds passed. Browser checks
covered opt-in, invalid link rejection, fresh review/hash, original MP4 match,
and editing locked after a match. No wallet approval or broadcast was made.

### Manual checkpoint — September 15, 2026

The maintainer tested the local profile editor in Chrome, changed the draft
name from `test123` to `Jaime Aguirre`, matched the original MP4 again, and
personally approved creator-paid Devnet issuance in Phantom. Screenshots supplied
by the maintainer show Explorer Success/Finalized, the hosted verifier displaying
the new profile, an exact local byte match, and 29/29 live technical checks passed.
These are user-observed results, not a fresh independent RPC check by the agent.

- Public profile: `Jaime Aguirre`; no portfolio or hire URL.
- Request: `request_devnet_e7397ea5-0262-41d7-b9b8-9c2579fdfec8`.
- Media SHA-256: `4d14352586b4d83d9bd469092ae735dde413d1c05080ac948618dc9284e07d2b`.
- Manifest SHA-256: `a7108625307904ce9172a357c97fddad93b2dd3ee940d683bcb81434a52ab953`.
- Attestation: `VYSKtu6jWt9FK5neV9SDVgP5aLcjqhyZar9PBEFcgJd`.
- [Finalized Devnet transaction](https://explorer.solana.com/tx/3EiaZCjjn83can5H1EwwK1GKMKLfiQbvCKrARyYgMeBZPTZav8CbijWupGCLY3WPRNQbW2owRfcpnQcPRTvFjSVN?cluster=devnet).
- Observed total wallet debit: 0.00531928 Devnet SOL.

The full public verifier URL was supplied in the task conversation. The hosted
verifier used for this check was build `d3cd3b3a`, before the Week 3 presentation
update. No new transaction is necessary to display this receipt in the updated
interface. Profile assertions are not independently verified legal identities.

Next: publish the validated interface with maintainer approval, check the hosted
receipt presentation, then collect actual creator feedback. Do not describe local
structural receipt fixtures as live on-chain profile evidence.

The isolated Velorn export integration already produces the canonical issue
request. Week 2 adds creator-paid browser issuance and receipt recovery. The
next increment is an optional public creator-profile experience, using the
existing request/manifest/receipt contracts.

## First increment

- Let a creator opt into the existing public profile fields before preparing
  a new request. Show exactly which entered values will be public.
- Carry those fields through the canonical manifest commitment and receipt.
  Editing a profile must create a newly reviewed request; it cannot silently
  change the metadata of an existing attestation.
- Present the profile clearly in the verifier, including the creator's
  portfolio or contact-for-hire link when provided.
- Keep the statement precise: the wallet asserted these profile fields. A
  successful chain check does not independently authenticate a name, website,
  professional history, or legal identity.
- Retain a complete flow with no profile supplied.

## Acceptance

1. An empty profile follows the existing export-to-verifier flow unchanged.
2. Opted-in profile fields survive canonical serialization and receipt parsing.
3. A modified profile cannot retain the original manifest hash or pass the
   original receipt's integrity checks.
4. Profile text and links are rendered safely; unsupported URL schemes fail.
5. A first-time tester can identify the signer, the asserted profile, the file
   match result, and the live-chain result without reading technical details.

After this increment, recruit the roadmap's ten creators and two independent
developers, record actual feedback and observed failures, and prioritize the
improvements they identify. Recruitment and messages require the maintainer's
explicit direction. Record completed sessions separately from planned ones.
