# Limitations and claim boundaries

This proof demonstrates that a Solana wallet signed a commitment to exact bytes. It does not demonstrate or guarantee:

- legal ownership or copyright;
- factual authorship, identity, or originality;
- that the signer had permission to use the media;
- permanent availability of the underlying media;
- a complete license agreement;
- C2PA compliance;
- durable revocation or supersession;
- Mainnet production readiness.

Anyone can make an attestation about bytes they possess. A verifier needs identity and legal context to decide how much trust to place in the signer.

Only hashes and compact identifiers are written on-chain. Filenames, local paths, prompts, project data, media, email addresses, and license prose are excluded. Although SHA-256 hashes do not reveal the media directly, they can confirm whether someone possesses an exact candidate file. Wallet activity is public and linkable, and RPC providers can observe queries.

Solana Devnet may reset and has no monetary value. The reproducible source, public receipt, and transaction evidence are the durable demonstration artifacts.

The verifier checks that receipt transaction references are successful Devnet signatures and that their Explorer URLs are consistent. Those statuses are supporting references; the independently derived PDAs and fetched SAS account ownership, relationships, signer, schema, and payload provide the substantive verification. This PoC does not yet decode every referenced transaction instruction into a creation-history proof.

SAS closing removes an active attestation account; it is not a complete, durable revocation history. The funded grant phase should define an explicit, reviewable supersession/revocation convention instead of claiming that SAS supplies one automatically.

This PoC uses a 365-day expiry specifically to exercise the verifier's expiry checks. It should not be interpreted as the proposed retention policy for production provenance records.
