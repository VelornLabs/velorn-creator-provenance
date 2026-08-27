# Canonical Devnet proof

This is the first complete live proof produced by the isolated Velorn Creator Provenance PoC. It uses synthetic fixture bytes and contains no private media, prompts, local paths, personal information, or secret key material.

## Result

- Network: Solana Devnet
- Devnet genesis hash: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
- Solana Attestation Service program: `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`
- Creator/credential authority: `UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR`
- First transaction block time: `2026-08-27T16:24:07Z`
- Public receipt written: `2026-08-27T16:24:10.263Z`
- Attestation expiry used for this PoC: `2027-08-27T16:24:09Z`
- Verification: **passed all 18 chain, schema, relationship, transaction-status, expiry, receipt, and local-byte checks**

## Public accounts

- [Credential `4dJQo...B2xxD`](https://explorer.solana.com/address/4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD?cluster=devnet)
- [Schema `3weC...SyHy5`](https://explorer.solana.com/address/3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5?cluster=devnet)
- [Attestation `7hVn...uVfYb`](https://explorer.solana.com/address/7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb?cluster=devnet)

All three accounts were fetched back from Devnet and verified as owned by the SAS program. The verifier independently rederived each PDA and checked the credential authority, authorized signer, schema relationship and shape, attestation nonce, expiry, and decoded commitment.

## Public transactions

- [Create credential](https://explorer.solana.com/tx/66JFqNVHyfPdhSm4ywGyY4PB44o1T2MkuB2mhoY2Q859MsWaDn2f87AzT1yknxJVjALC3n5Z6KaMFakyjHpTn99A?cluster=devnet) — slot `488936441`, fee `5,001` lamports, `6,475` compute units
- [Create schema](https://explorer.solana.com/tx/Pui76Rv21uioBN33R7VpJvJXgxvwMDUtCxAAQQD65ieifjs1hEnrCFHJfJZ2DqoHWbNRUJoJRRe3LLwC6hKuftT?cluster=devnet) — slot `488936446`, fee `5,001` lamports, `6,070` compute units
- [Create attestation](https://explorer.solana.com/tx/3sMCHShM8utNQawse9AErnwReQBArwzEKeQcfC99Ysz6CTiGsozE3ub6zPRhjStpPqXLQm5FATkpKzRy8fG25v3M?cluster=devnet) — slot `488936452`, fee `5,001` lamports, `6,397` compute units

The three successful transactions occurred in consecutive observed block times at `16:24:07Z`, `16:24:08Z`, and `16:24:09Z`. Total transaction fees were `15,003` lamports. The three SAS accounts held `7,196,640` lamports in rent-exempt balances, for a total payer balance change of `7,211,643` lamports during this run.

## Committed fixture hashes

- Media SHA-256: `f24204e5f7a75d5d95a3f6b4357becf64b014e1f85cfc3bf3f9b19e2f3e8c573`
- Canonical manifest SHA-256: `0a7c2d942a9eb53a14897231664be6970376ff6eb2e4918c12ae7235aa804c5d`
- Statement type: `creator_media_commitment_v1`
- Schema/commitment version: `1`

The canonical public receipt is stored in [`devnet-receipt.json`](devnet-receipt.json). To repeat the full public-chain and local-byte verification:

```bash
npm ci
npm test
npm run build
npm run verify -- evidence/devnet-receipt.json \
  fixtures/sample-export.txt \
  fixtures/sample-provenance-manifest.json
```

The successful run used pinned `sas-lib@1.0.10` and `@solana/kit@5.5.1`. The source, tests, and receipt from that run are preserved in implementation commit [`7c187f2566d54fc21b7e37d27ab11edfb19d17ab`](https://github.com/VelornLabs/velorn-creator-provenance/commit/7c187f2566d54fc21b7e37d27ab11edfb19d17ab).

The narrow RPC evidence projection is stored in [`chain-metadata.json`](chain-metadata.json), and the independently repeated verifier output is preserved in [`verify-local.txt`](verify-local.txt). The raw fixture manifest file has SHA-256 `05dee66f2d1709664bdcb38b955472b4ad893753154f50f0a127a51b86d36b73`; that differs intentionally from the on-chain manifest commitment because the latter hashes the canonicalized JSON representation.

## Claim boundaries

This demonstrates that a Solana wallet signed a public SAS commitment to exact fixture bytes and that the commitment can be independently fetched and verified. It does not by itself prove identity, factual authorship, originality, copyright ownership, permission, a complete license, C2PA compliance, or a durable revocation history. Devnet can reset, so the source, receipt, and transaction references are retained as reproducible evidence.
