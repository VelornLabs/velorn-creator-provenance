# Browser-wallet sponsored Devnet proof

This directory preserves the public evidence from the first complete Velorn
Creator Provenance browser-wallet flow run during the Eternal sprint. A Phantom
Devnet account created its SAS credential and schema, reviewed and signed an
exact media commitment, and a separate Velorn Devnet sponsor paid for and
submitted the attestation.

## Result

- Network: Solana Devnet
- Creator: `FrSCbpAawSmLejtM1x5bwx8xsNpq395vjiq84u3Mxjcy`
- Sponsor: `UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR`
- Credential: [`AuyCU...z9ePj`](https://explorer.solana.com/address/AuyCUqEM2zobANdo3mpJkx8jBLxTPmG6vQ75FPEz9ePj?cluster=devnet)
- Schema: [`G6EUj...U97wY`](https://explorer.solana.com/address/G6EUjJXivfjAAUYHc364ytZpBvWhD2bkajucskaU97wY?cluster=devnet)
- Attestation: [`BNA3g...wdXAf`](https://explorer.solana.com/address/BNA3gBtCV4WjgTzwCXZE3bTr98fqbHGfAn8emkCwdXAf?cluster=devnet)

The creator enrollment transaction finalized at `2026-08-28T22:45:55Z`:

- [Create credential and schema](https://explorer.solana.com/tx/tm2kphUYn2aS5MB4g2h6qJn7G1hcqtzhk53dFtrUWWJZJtuqCUES6RQHY6vxK1oqe8jAEgEUYVoaB22RkRWoddP?cluster=devnet)

The sponsored proof transaction finalized at `2026-08-28T22:49:24Z`:

- [Create attestation](https://explorer.solana.com/tx/2vSD8YQZqvR8JAPao6LDvXjwccGJqZsWV1VACn9NN7cFBmrSVNL3KKJyN3EtP4D62oumQKGQfk3tMMTeHe8zC7ZD?cluster=devnet)

The creator balance was exactly `996,062,200` lamports immediately before and
after the attestation transaction. The separate sponsor paid the `10,200`
lamport transaction fee and funded the attestation account's `3,264,240`
lamport rent-exempt balance.

## Verification

`public-receipt.json` is a sanitized public receipt reconstructed at
`2026-08-28T23:17:51.530Z` from finalized Devnet accounts and transactions. The
guided harness did not emit a receipt during this run, so this timestamp records
the reconstruction rather than the transaction's block time. The receipt
contains no private key, seed phrase, filename, local path, prompt, or media
bytes. The chain-only verifier passed all 17 account, PDA, role, schema, expiry,
commitment, and transaction-status checks:

```bash
npm run verify -- evidence/eternal-wallet-proof-2026-08-28/public-receipt.json
```

The exact output is preserved in `verify-chain.txt`; the narrow finalized RPC
projection is preserved in `chain-metadata.json`.

The selected media was a local GIF and was not archived in this repository.
A read-only local check found the exact `8,350,671` selected bytes and produced
SHA-256
`525b7efedc0d84f130c5a37f1ddc84cff5b7468feaa151cf9706a2601ae89fa0`,
which exactly matches the decoded on-chain media commitment. The sanitized
result is preserved in `verify-local-media.txt`; it intentionally omits the
filename and local path. The media cannot be recovered from the public record.

## Claim boundaries

This proves that the creator wallet signed the exact transaction message and
asserted the recorded commitment, while a distinct sponsor paid for the proof.
It does not independently prove legal identity, factual authorship, originality,
copyright ownership, permission, licensing rights, or C2PA trust. Devnet may be
reset, so these sanitized artifacts and source are retained as reproducible
sprint evidence.
