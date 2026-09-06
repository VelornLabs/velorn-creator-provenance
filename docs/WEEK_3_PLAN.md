# Week 3 starting point

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
