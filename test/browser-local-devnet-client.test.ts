import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  createShareableProvenanceReceipt,
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "../src/contracts.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  devnetAccountUrl,
  devnetTransactionUrl,
} from "../src/receipt.js";
import {
  LocalDevnetClientError,
  createLocalDevnetHarnessClient,
  type LocalDevnetFetch,
  type LocalDevnetFetchInit,
  type LocalDevnetFetchResponse,
} from "../web/src/local-devnet-client.js";

const ORIGIN = "http://127.0.0.1:4173";
const CREATOR = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";
const OTHER_CREATOR = "9JWH8mSgs97njH8hWGJ8uJU7L9YuwaDZBeW9PzwsAkwN";
const SPONSOR = "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const CREDENTIAL = "3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5";
const SCHEMA = "7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb";
const ATTESTATION = "DfjwifQfVV2iM4EVjHeFdVJZ3u4a4NZoGxVoWp44UA7F";
const ENROLLMENT_PLAN_ID = "E".repeat(22);
const ATTESTATION_PLAN_ID = "A".repeat(22);
const CSRF = "C".repeat(43);
const TRANSACTION = "AQ==";
const TRANSACTION_SIGNATURE =
  "3sMCHShM8utNQawse9AErnwReQBArwzEKeQcfC99Ysz6CTiGsozE3ub6zPRhjStpPqXLQm5FATkpKzRy8fG25v3M";
const OTHER_TRANSACTION_SIGNATURE =
  "66JFqNVHyfPdhSm4ywGyY4PB44o1T2MkuB2mhoY2Q859MsWaDn2f87AzT1yknxJVjALC3n5Z6KaMFakyjHpTn99A";

interface FetchCall {
  readonly path: string;
  readonly init: LocalDevnetFetchInit;
}

function response(
  body: unknown,
  options: Readonly<{
    status?: number;
    url?: string;
    redirected?: boolean;
    contentType?: string;
    contentLength?: string;
    raw?: boolean;
  }> = {},
): LocalDevnetFetchResponse {
  const text = options.raw ? String(body) : JSON.stringify(body);
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json; charset=utf-8",
    ...(options.contentLength === undefined
      ? {}
      : { "Content-Length": options.contentLength }),
  });
  const result = new Response(text, {
    status: options.status ?? 200,
    headers,
  });
  Object.defineProperties(result, {
    url: { value: options.url ?? "", configurable: true },
    redirected: { value: options.redirected ?? false, configurable: true },
  });
  return result;
}

class FetchQueue {
  readonly calls: FetchCall[] = [];
  readonly #responses: LocalDevnetFetchResponse[];

  constructor(responses: readonly LocalDevnetFetchResponse[]) {
    this.#responses = [...responses];
  }

  readonly fetch: LocalDevnetFetch = async (path, init) => {
    this.calls.push({ path, init });
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next.url === "") {
      Object.defineProperty(next, "url", {
        value: `${ORIGIN}${path}`,
        configurable: true,
      });
    }
    return next;
  };
}

function session(extra: Record<string, unknown> = {}) {
  return {
    contract: "velorn.local-devnet.session",
    version: 1,
    csrfToken: CSRF,
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: SPONSOR,
    ...extra,
  };
}

function connectResult(extra: Record<string, unknown> = {}) {
  return {
    creatorAuthority: CREATOR,
    enrollmentState: "required",
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    ...extra,
  };
}

function enrollmentPlan(extra: Record<string, unknown> = {}) {
  return {
    kind: "transaction",
    planId: ENROLLMENT_PLAN_ID,
    creatorAuthority: CREATOR,
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    unsignedTransactionBase64: TRANSACTION,
    ...extra,
  };
}

function enrollmentResult(extra: Record<string, unknown> = {}) {
  return {
    state: "confirmed",
    planId: ENROLLMENT_PLAN_ID,
    creatorAuthority: CREATOR,
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    transactionSignature: TRANSACTION_SIGNATURE,
    ...extra,
  };
}

function enrollmentStatus(
  state: "prepared" | "submitted" | "confirmed" | "failed",
  extra: Record<string, unknown> = {},
) {
  return {
    state,
    planId: ENROLLMENT_PLAN_ID,
    creatorAuthority: CREATOR,
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    ...(state === "submitted" || state === "confirmed"
      ? { transactionSignature: TRANSACTION_SIGNATURE }
      : {}),
    ...extra,
  };
}

function provenanceRequest(
  requestId = "request_browser_client_0001",
): ProvenanceRequestV1 {
  return createProvenanceRequest({
    requestId,
    mediaSha256: "11".repeat(32),
    manifest: {
      contract: PROVENANCE_MANIFEST_CONTRACT,
      version: CONTRACT_VERSION,
      statement: CREATOR_RELATIONSHIP_STATEMENT,
      declaredAt: "2026-08-28T16:00:00.000Z",
      media: {
        byteLength: "42",
        mimeType: "video/mp4",
      },
      lifecycle: {
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "issue",
      },
    },
  });
}

function attestationPlan(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    planId: ATTESTATION_PLAN_ID,
    requestId,
    creatorAuthority: CREATOR,
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    attestationAddress: ATTESTATION,
    subjectNonce: OTHER_CREATOR,
    createCredentialTransactionSignature: TRANSACTION_SIGNATURE,
    createSchemaTransactionSignature: TRANSACTION_SIGNATURE,
    unsignedTransactionBase64: TRANSACTION,
    messageSha256: "22".repeat(32),
    expiryUnixSeconds: "1787936400",
    ...extra,
  };
}

function shareableReceipt(request = provenanceRequest()) {
  return createShareableProvenanceReceipt(request, {
    receiptVersion: 1,
    network: "devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: `VELORN-PROV-${CREATOR.slice(0, 8)}`,
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
    attestationAddress: ATTESTATION,
    credentialAuthority: CREATOR,
    authorizedSigner: CREATOR,
    subjectNonce: OTHER_CREATOR,
    commitment: request.commitment,
    expiryUnixSeconds: "1787936400",
    accountExplorerUrls: {
      credential: devnetAccountUrl(CREDENTIAL),
      schema: devnetAccountUrl(SCHEMA),
      attestation: devnetAccountUrl(ATTESTATION),
    },
    transactions: {
      createCredential: {
        signature: TRANSACTION_SIGNATURE,
        explorerUrl: devnetTransactionUrl(TRANSACTION_SIGNATURE),
      },
      createSchema: {
        signature: TRANSACTION_SIGNATURE,
        explorerUrl: devnetTransactionUrl(TRANSACTION_SIGNATURE),
      },
      createAttestation: {
        signature: TRANSACTION_SIGNATURE,
        explorerUrl: devnetTransactionUrl(TRANSACTION_SIGNATURE),
      },
    },
    receiptWrittenAt: "2026-08-28T17:00:00.000Z",
    implementation: {
      sasLib: "1.0.10",
      solanaKit: "5.5.1",
    },
  });
}

function attestationStatus(
  requestId: string,
  state: "prepared" | "submitted" | "confirmed" | "failed",
  extra: Record<string, unknown> = {},
) {
  return {
    state,
    planId: ATTESTATION_PLAN_ID,
    requestId,
    creatorAuthority: CREATOR,
    attestationAddress: ATTESTATION,
    ...(state === "submitted" || state === "confirmed"
      ? { transactionSignature: TRANSACTION_SIGNATURE }
      : {}),
    ...(state === "confirmed" ? { receipt: shareableReceipt() } : {}),
    ...extra,
  };
}

async function connectClient(queue: FetchQueue) {
  const client = createLocalDevnetHarnessClient(queue.fetch);
  await client.startSession();
  await client.connectCreator(CREATOR);
  return client;
}

function assertClientError(error: unknown, code: string): boolean {
  assert.ok(error instanceof LocalDevnetClientError);
  assert.equal(error.code, code);
  return true;
}

test("the native browser-style fetch boundary is directly injectable", () => {
  const compatibleFetch: LocalDevnetFetch = fetch;
  const client = createLocalDevnetHarnessClient(compatibleFetch);
  assert.ok(client);
});

test("creation is inert and stateful methods cannot run before explicit setup", async () => {
  let fetchCalls = 0;
  const client = createLocalDevnetHarnessClient(async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  });

  assert.equal(fetchCalls, 0);
  await assert.rejects(
    client.connectCreator(CREATOR),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  await assert.rejects(
    client.planEnrollment(),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  await assert.rejects(
    client.beginAttestation(provenanceRequest()),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  assert.equal(fetchCalls, 0);
});

test("session uses only the fixed relative path and keeps the CSRF token private", async () => {
  const queue = new FetchQueue([response(session())]);
  const client = createLocalDevnetHarnessClient(queue.fetch);

  const result = await client.startSession();

  assert.deepEqual(result, {
    contract: "velorn.local-devnet.session",
    version: 1,
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: SPONSOR,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal("csrfToken" in result, false);
  assert.equal(queue.calls.length, 1);
  assert.equal(queue.calls[0]?.path, "/__local-devnet/session");
  assert.deepEqual(queue.calls[0]?.init, {
    method: "GET",
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
});

test("runs the explicit fixed enrollment and attestation API sequence", async () => {
  const request = provenanceRequest();
  const queue = new FetchQueue([
    response(session()),
    response(connectResult()),
    response(enrollmentPlan()),
    response(enrollmentResult()),
    response(attestationPlan(request.requestId)),
    response(attestationStatus(request.requestId, "submitted")),
    response(attestationStatus(request.requestId, "confirmed")),
  ]);
  const client = await connectClient(queue);

  const plannedEnrollment = await client.planEnrollment();
  assert.equal(plannedEnrollment.kind, "transaction");
  if (plannedEnrollment.kind !== "transaction") {
    throw new Error("transaction fixture was not returned");
  }
  assert.equal(plannedEnrollment.unsignedTransactionBase64, TRANSACTION);
  assert.equal(Object.isFrozen(plannedEnrollment), true);
  await client.completeEnrollment(TRANSACTION);

  const plannedAttestation = await client.beginAttestation(request);
  assert.equal(plannedAttestation.unsignedTransactionBase64, TRANSACTION);
  assert.equal(Object.isFrozen(plannedAttestation), true);
  const submitted = await client.completeAttestation(TRANSACTION);
  assert.equal(submitted.state, "submitted");
  const confirmed = await client.getAttestationStatus();
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.transactionSignature, TRANSACTION_SIGNATURE);

  assert.deepEqual(
    queue.calls.map(({ path }) => path),
    [
      "/__local-devnet/session",
      "/__local-devnet/connect",
      "/__local-devnet/enrollment/plan",
      "/__local-devnet/enrollment/complete",
      "/__local-devnet/attestation/begin",
      "/__local-devnet/attestation/complete",
      "/__local-devnet/attestation/status",
    ],
  );
  for (const call of queue.calls.slice(1)) {
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.mode, "same-origin");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers["x-velorn-csrf"], CSRF);
    assert.equal(call.init.headers["Content-Type"], "application/json");
  }
  const beginBody = queue.calls[4]?.init.body;
  assert.equal(
    beginBody,
    `{"creatorAuthority":${JSON.stringify(CREATOR)},"request":${serializeCanonicalProvenanceRequestJson(request)}}`,
  );
});

test("checks an ambiguous enrollment without signing or submitting again", async () => {
  const queue = new FetchQueue([
    response(session()),
    response(connectResult()),
    response(enrollmentPlan()),
    response(enrollmentStatus("submitted")),
    response(enrollmentStatus("confirmed")),
  ]);
  const client = await connectClient(queue);
  await client.planEnrollment();

  const submitted = await client.getEnrollmentStatus();
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.transactionSignature, TRANSACTION_SIGNATURE);
  const confirmed = await client.getEnrollmentStatus();
  assert.equal(confirmed.state, "confirmed");

  const callsAfterConfirmation = queue.calls.length;
  await assert.rejects(
    client.getEnrollmentStatus(),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  assert.equal(queue.calls.length, callsAfterConfirmation);
  assert.deepEqual(
    queue.calls.map(({ path }) => path),
    [
      "/__local-devnet/session",
      "/__local-devnet/connect",
      "/__local-devnet/enrollment/plan",
      "/__local-devnet/enrollment/status",
      "/__local-devnet/enrollment/status",
    ],
  );
});

test("supports the no-transaction reused enrollment response", async () => {
  const queue = new FetchQueue([
    response(session()),
    response({ ...connectResult(), enrollmentState: "ready" }),
    response({
      kind: "reused",
      creatorAuthority: CREATOR,
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
    }),
  ]);
  const client = await connectClient(queue);

  const result = await client.planEnrollment();
  assert.deepEqual(result, {
    kind: "reused",
    creatorAuthority: CREATOR,
    credentialAddress: CREDENTIAL,
    schemaAddress: SCHEMA,
  });
  await assert.rejects(
    client.completeEnrollment(TRANSACTION),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  assert.equal(queue.calls.length, 3);
});

test("rejects extra response fields at the session, plan, and status boundaries", async () => {
  {
    const queue = new FetchQueue([response(session({ extra: true }))]);
    const client = createLocalDevnetHarnessClient(queue.fetch);
    await assert.rejects(
      client.startSession(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
  {
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(enrollmentPlan({ extra: true })),
    ]);
    const client = await connectClient(queue);
    await assert.rejects(
      client.planEnrollment(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
  {
    const request = provenanceRequest();
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(attestationPlan(request.requestId)),
      response(attestationStatus(request.requestId, "confirmed", { extra: true })),
    ]);
    const client = await connectClient(queue);
    await client.beginAttestation(request);
    await assert.rejects(
      client.getAttestationStatus(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
});

test("accepts receipts only on confirmed status and cross-binds every public proof identity", async () => {
  const request = provenanceRequest();
  const altered = (
    mutate: (receipt: ReturnType<typeof shareableReceipt>) => void,
  ) => {
    const receipt = structuredClone(shareableReceipt(request));
    mutate(receipt);
    return receipt;
  };
  const invalidReceipts = [
    shareableReceipt(provenanceRequest("request_browser_client_9999")),
    altered((receipt) => {
      receipt.chainReceipt.credentialAuthority = OTHER_CREATOR;
      receipt.chainReceipt.authorizedSigner = OTHER_CREATOR;
    }),
    altered((receipt) => {
      receipt.chainReceipt.credentialAddress = OTHER_CREATOR;
      receipt.chainReceipt.accountExplorerUrls.credential =
        devnetAccountUrl(OTHER_CREATOR);
    }),
    altered((receipt) => {
      receipt.chainReceipt.schemaAddress = OTHER_CREATOR;
      receipt.chainReceipt.accountExplorerUrls.schema =
        devnetAccountUrl(OTHER_CREATOR);
    }),
    altered((receipt) => {
      receipt.chainReceipt.attestationAddress = OTHER_CREATOR;
      receipt.chainReceipt.accountExplorerUrls.attestation =
        devnetAccountUrl(OTHER_CREATOR);
    }),
    altered((receipt) => {
      receipt.chainReceipt.subjectNonce = SPONSOR;
    }),
    altered((receipt) => {
      receipt.chainReceipt.transactions.createCredential.signature =
        OTHER_TRANSACTION_SIGNATURE;
      receipt.chainReceipt.transactions.createCredential.explorerUrl =
        devnetTransactionUrl(OTHER_TRANSACTION_SIGNATURE);
    }),
    altered((receipt) => {
      receipt.chainReceipt.transactions.createSchema.signature =
        OTHER_TRANSACTION_SIGNATURE;
      receipt.chainReceipt.transactions.createSchema.explorerUrl =
        devnetTransactionUrl(OTHER_TRANSACTION_SIGNATURE);
    }),
    altered((receipt) => {
      receipt.chainReceipt.transactions.createAttestation.signature =
        OTHER_TRANSACTION_SIGNATURE;
      receipt.chainReceipt.transactions.createAttestation.explorerUrl =
        devnetTransactionUrl(OTHER_TRANSACTION_SIGNATURE);
    }),
  ];

  for (const receipt of invalidReceipts) {
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(attestationPlan(request.requestId)),
      response(attestationStatus(request.requestId, "confirmed", { receipt })),
    ]);
    const client = await connectClient(queue);
    await client.beginAttestation(request);
    await assert.rejects(
      client.getAttestationStatus(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }

  const confirmedWithoutReceipt = attestationStatus(
    request.requestId,
    "confirmed",
  ) as Record<string, unknown>;
  delete confirmedWithoutReceipt.receipt;
  const forbiddenShapes = [
    confirmedWithoutReceipt,
    attestationStatus(request.requestId, "submitted", {
      receipt: shareableReceipt(request),
    }),
  ];
  for (const status of forbiddenShapes) {
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(attestationPlan(request.requestId)),
      response(status),
    ]);
    const client = await connectClient(queue);
    await client.beginAttestation(request);
    await assert.rejects(
      client.getAttestationStatus(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
});

test("rejects malformed, oversized, mistyped, redirected, and cross-origin responses", async () => {
  const cases: readonly LocalDevnetFetchResponse[] = [
    response("not json", { raw: true }),
    response(session(), { contentType: "text/plain" }),
    response(`${JSON.stringify(session())}${" ".repeat(2_100)}`, { raw: true }),
    response(session(), { contentLength: "999999" }),
    response(session(), { redirected: true }),
    response(session(), { url: "https://attacker.example/__local-devnet/session" }),
    response(session(), { url: `${ORIGIN}/__local-devnet/session?redirected=1` }),
  ];
  for (const candidate of cases) {
    const queue = new FetchQueue([candidate]);
    const client = createLocalDevnetHarnessClient(queue.fetch);
    await assert.rejects(
      client.startSession(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
    assert.equal(queue.calls[0]?.path, "/__local-devnet/session");
    assert.equal(queue.calls[0]?.init.mode, "same-origin");
    assert.equal(queue.calls[0]?.init.redirect, "error");
  }
});

test("rejects noncanonical transaction data and mismatched response identities", async () => {
  {
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(enrollmentPlan({ unsignedTransactionBase64: "AB==" })),
    ]);
    const client = await connectClient(queue);
    await assert.rejects(
      client.planEnrollment(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
  {
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(enrollmentPlan()),
    ]);
    const client = await connectClient(queue);
    await client.planEnrollment();
    await assert.rejects(
      client.completeEnrollment("AB=="),
      (error) => assertClientError(error, "INVALID_INPUT"),
    );
    assert.equal(queue.calls.length, 3);
  }
  {
    const request = provenanceRequest();
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(attestationPlan(request.requestId, { planId: "Z".repeat(22) })),
    ]);
    const client = await connectClient(queue);
    const plan = await client.beginAttestation(request);
    assert.equal(plan.planId, "Z".repeat(22));
  }
  {
    const request = provenanceRequest();
    const queue = new FetchQueue([
      response(session()),
      response(connectResult()),
      response(attestationPlan(request.requestId)),
      response({
        ...attestationStatus(request.requestId, "submitted"),
        transactionSignature: undefined,
      }),
    ]);
    const client = await connectClient(queue);
    await client.beginAttestation(request);
    await assert.rejects(
      client.getAttestationStatus(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
});

test("rejects hostile input before fetch and binds exactly one creator", async () => {
  const queue = new FetchQueue([
    response(session()),
    response(connectResult()),
  ]);
  const client = await connectClient(queue);
  const callsAfterConnect = queue.calls.length;

  await assert.rejects(
    client.connectCreator(OTHER_CREATOR),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  await assert.rejects(
    client.connectCreator("https://attacker.example"),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  await assert.rejects(
    client.beginAttestation({ ...provenanceRequest(), extra: true } as never),
    (error) => assertClientError(error, "INVALID_INPUT"),
  );
  assert.equal(queue.calls.length, callsAfterConnect);
});

test("propagates only a strict bounded server failure envelope", async () => {
  {
    const queue = new FetchQueue([
      response(
        {
          error: {
            code: "SESSION_LOCKED",
            message: "This process already has a local session.",
          },
        },
        { status: 409 },
      ),
    ]);
    const client = createLocalDevnetHarnessClient(queue.fetch);
    await assert.rejects(client.startSession(), (error: unknown) => {
      assert.ok(error instanceof LocalDevnetClientError);
      assert.equal(error.code, "SESSION_LOCKED");
      assert.equal(error.status, 409);
      assert.equal(error.message, "This process already has a local session.");
      return true;
    });
  }
  {
    const queue = new FetchQueue([
      response(
        {
          error: {
            code: "SESSION_LOCKED",
            message: "safe",
            internal: "must not pass",
          },
        },
        { status: 409 },
      ),
    ]);
    const client = createLocalDevnetHarnessClient(queue.fetch);
    await assert.rejects(
      client.startSession(),
      (error) => assertClientError(error, "INVALID_RESPONSE"),
    );
  }
});

test("wraps injected transport failure without retrying or exposing its message", async () => {
  let calls = 0;
  const client = createLocalDevnetHarnessClient(async () => {
    calls += 1;
    throw new Error("https://secret.invalid/?token=do-not-expose");
  });

  await assert.rejects(client.startSession(), (error: unknown) => {
    assert.ok(error instanceof LocalDevnetClientError);
    assert.equal(error.code, "REQUEST_FAILED");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(calls, 1);
});
