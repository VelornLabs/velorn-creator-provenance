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

The hosted issuer requires an exact local byte match and separate explicit
connect, prepare, review, and sign actions. Opening an issue link alone does
nothing. It has no media upload, application server, embedded private key, or
gas sponsor; the connected creator pays the transaction fee and rent-exempt
deposits with Devnet SOL.

Each hosted proof creates a proof-scoped SAS credential, schema, and attestation
in one atomic transaction. That provides self-contained v1 creation evidence,
but it also creates three rent-bearing accounts per proof. Reusing one creator
credential and schema would be more rent-efficient, but requires durable
creation-history discovery or a future receipt version that can accurately
describe already-existing verified accounts.

The browser's canonical same-origin recovery store holds at most eight public
status records, keyed by request binding. Each uses the transaction signature
derived from the signed wire, its SHA-256 digest, and the prepared
`minContextSlot`; it never stores the signed wire itself. Reload recovery can
check that signature, fetch the finalized signed wire from the fixed RPC,
match its digest, and revalidate the exact instructions and creator signature
before assembling a receipt. It cannot sign, send, resubmit, or rebroadcast.

Recovery-store operations require browser Web Locks for safe cross-tab
serialization. If safe coordination is unavailable, issuance fails closed.
Clearing uses a per-record compare-and-clear so one tab cannot remove a newer
replacement. Unresolved records are not removed based only on wall-clock age,
and finalized records remain until explicit clear or durable handoff. If the
saved signature failed or is absent, retry clearing also requires finalized
blockhash invalidity followed by finalized absence of every intended account,
with the account read anchored to the blockhash-validity response context. If the
bounded store cannot safely accept another unresolved record, a new send is
blocked rather than silently losing recovery evidence.

These records contain no secrets, but they correlate public requests, creator
wallets, SAS accounts, and transaction signatures. Scripts running on the same
origin and people with access to the browser profile can read them. Clearing
browser storage removes the recovery convenience and does not alter any
transaction that already reached Devnet.

Solana Devnet may reset and has no monetary value. The reproducible source, public receipt, and transaction evidence are the durable demonstration artifacts.

The verifier checks that receipt transaction references are successful Devnet signatures and that their Explorer URLs are consistent. In the hosted atomic flow, the same finalized signature fills all three v1 creation references because that one transaction creates the credential, schema, and attestation. Those statuses are supporting references; the independently derived PDAs and fetched SAS account ownership, relationships, signer, schema, and payload provide the substantive verification. This PoC does not yet decode every referenced transaction instruction into a creation-history proof.

SAS closing removes an active attestation account; it is not a complete, durable revocation history. The funded grant phase should define an explicit, reviewable supersession/revocation convention instead of claiming that SAS supplies one automatically.

The local harness uses a 365-day expiry specifically to exercise the verifier's expiry checks, while the hosted creator-paid issuer generates and reviews a 30-day expiry. Neither should be interpreted as the proposed retention policy for production provenance records.
