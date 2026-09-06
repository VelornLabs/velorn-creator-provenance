# Week 2 creator-paid Devnet proof

On September 6, 2026, Jaime completed the browser Wallet Standard flow with
Phantom in Testnet Mode, using the exact MP4 request produced by the isolated
Velorn export integration on August 31. The issuer ran from a local production
preview of the Week 2 code. This run alone does not establish that the hosted
GitHub Pages issuer has been tested.

The creator approved one transaction creating the proof's SAS credential,
schema, and attestation atomically. Velorn fetched and revalidated the finalized
transaction bytes before producing the receipt. All three receipt creation
references therefore use the same transaction.

- Creator: `FrSCbpAawSmLejtM1x5bwx8xsNpq395vjiq84u3Mxjcy`
- Attestation: `5Bx2c2Qmq2fBBRU98LonKCbGAYtTuHzhk1YyTK3xHQ8v`
- [Finalized transaction](https://explorer.solana.com/tx/M9Z6TwC2h2rc1WoYDXzMU1yFtmwXagNbWvUCXyik4fV1BSKSFk2d4EeV12dBf2Xp5S93GKJAUaKkvGpFZJPJGw2?cluster=devnet)
- Media: 11,009,996 bytes, declared MIME type `video/mp4`.
- Media SHA-256: `4d14352586b4d83d9bd469092ae735dde413d1c05080ac948618dc9284e07d2b`.
- Receipt assembled at `2026-09-06T18:18:08.035Z`; this is not the on-chain timestamp.
- Proof expiry: Unix seconds `1791310672` (30-day test policy).

The first prepared quote became stale while being reviewed. The pre-signing
guard rejected it before wallet signing or submission. The user discarded it,
prepared a fresh quote, and completed the flow. This motivated the explicit
Refresh transaction action added after the run.

## Preserved evidence

`public-receipt.json` preserves the exact decoded public verifier payload.
`verifier-url.txt` preserves the canonical hosted verifier link.
`verification.json` records the subsequent read-only check at
`2026-09-06T18:34:36.176Z`: all 29 live checks passed, and the locally hashed
MP4 matched. The browser verifier also showed both successful results.
The original media, filename, local path, private keys, and signed wallet wire
are not included in this evidence directory.

To reproduce the link, call `publicVerifierUrl(receipt)` from
`web/src/public-verifier-url.ts`. To check the current chain state, call
`verifyShareableReceiptOnDevnet(receipt)` from `src/verify-chain.ts`, or open
the preserved URL and choose **Check live Solana Devnet**. For an exact-file
check, choose the original MP4 locally; selecting a different or re-encoded
file should fail.

The receipt is a wallet assertion about exact bytes. It does not establish
copyright, legal identity, authorship, or permission. Devnet may reset; live
expiry and availability results can change after this recorded observation.
