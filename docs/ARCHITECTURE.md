# Architecture

This Phase 0 proof has two deliberately separate layers.

## Local commitment layer

The client hashes the exact bytes of a media fixture with SHA-256. It also canonicalizes a small provenance statement and hashes that canonical UTF-8 representation. The media and statement remain local.

The statement is intentionally not described as C2PA. A production C2PA adapter must follow C2PA's format-specific hard-binding rules instead of naïvely hashing a file and then embedding data into it.

## Solana attestation layer

The proof uses the deployed Solana Attestation Service program on Devnet:

`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`

A disposable creator signer is simultaneously:

- the credential authority;
- an authorized credential signer; and
- the native signer recorded by the attestation account.

A fresh public nonce address makes the attestation PDA unique. The nonce does not hold funds or sign.

The SAS schema contains four fields:

| Field | SAS type | Meaning |
| --- | --- | --- |
| `media_sha256` | String | Lowercase SHA-256 digest of exact media bytes |
| `manifest_sha256` | String | SHA-256 digest of the canonical provenance statement |
| `statement_type` | String | `creator_media_commitment_v1` |
| `version` | U8 | `1` |

The verifier independently fetches credential, schema, and attestation accounts; checks SAS program ownership and PDA/account relationships; verifies signer roles, schema status/shape, and expiry; decodes the payload; and optionally recomputes both local commitments.

## Isolation boundary

This repository is not a Velorn workspace package, Git worktree, submodule, runtime dependency, or linked directory. A future desktop integration is a separate phase and must be reviewed on its own branch after this public proof is accepted.
