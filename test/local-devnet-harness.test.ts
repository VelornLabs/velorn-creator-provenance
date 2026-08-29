import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  type ProvenanceRequestV1,
} from "../src/contracts.js";
import {
  createLocalDevnetHarnessMiddleware,
  LOCAL_DEVNET_HARNESS_COOKIE,
  LOCAL_DEVNET_HARNESS_CSRF_HEADER,
  LOCAL_DEVNET_HARNESS_HOST,
  LOCAL_DEVNET_HARNESS_ORIGIN,
  type LocalDevnetHarnessAttestationPlan,
  type LocalDevnetHarnessAttestationStatus,
  type LocalDevnetHarnessConnectResult,
  type LocalDevnetHarnessEnrollmentPlan,
  type LocalDevnetHarnessEnrollmentResult,
  type LocalDevnetHarnessEnrollmentStatus,
  type LocalDevnetHarnessFlowService,
  type LocalDevnetHarnessPublicConfiguration,
} from "../src/local-devnet-harness.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "../src/receipt.js";
import { createLocalDevnetViteConfig } from "../vite.devnet.config.js";
import { LOCAL_DEVNET_HARNESS_CSP } from "../vite.devnet.config.js";

const CREATOR = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";
const OTHER_CREATOR = "9JWH8mSgs97njH8hWGJ8uJU7L9YuwaDZBeW9PzwsAkwN";
const SPONSOR = "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const CREDENTIAL = "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const SCHEMA = "3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5";
const ATTESTATION = "7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb";
const ENROLLMENT_PLAN_ID = "E".repeat(22);
const ATTESTATION_PLAN_ID = "A".repeat(22);
const SIGNED_TRANSACTION = "AQ==";
const TRANSACTION_SIGNATURE =
  "3sMCHShM8utNQawse9AErnwReQBArwzEKeQcfC99Ysz6CTiGsozE3ub6zPRhjStpPqXLQm5FATkpKzRy8fG25v3M";

function provenanceRequest(): ProvenanceRequestV1 {
  return createProvenanceRequest({
    requestId: "request_harness_000001",
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

class MockFlow implements LocalDevnetHarnessFlowService {
  readonly publicConfiguration: LocalDevnetHarnessPublicConfiguration = {
    network: "solana:devnet" as const,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: SPONSOR,
  };

  connectCalls = 0;
  enrollmentPlanCalls = 0;
  enrollmentCompleteCalls = 0;
  enrollmentStatusCalls = 0;
  attestationBeginCalls = 0;
  attestationCompleteCalls = 0;
  attestationStatusCalls = 0;
  enrollmentPlanKind: "reused" | "transaction" = "reused";
  completionState: "submitted" | "confirmed" = "submitted";
  statusState: "submitted" | "confirmed" = "confirmed";
  enrollmentStatusState: LocalDevnetHarnessEnrollmentStatus["state"] =
    "confirmed";
  throwConnect: unknown;
  connectResultExtension: Record<string, unknown> | undefined;
  expiryUnixSeconds = "1787936400";

  async connectCreator(input: {
    creatorAuthority: string;
  }): Promise<LocalDevnetHarnessConnectResult> {
    this.connectCalls += 1;
    if (this.throwConnect !== undefined) throw this.throwConnect;
    return {
      creatorAuthority: input.creatorAuthority,
      enrollmentState: this.enrollmentPlanKind === "reused" ? "ready" : "required",
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
      ...this.connectResultExtension,
    } as LocalDevnetHarnessConnectResult;
  }

  async planEnrollment(input: {
    creatorAuthority: string;
  }): Promise<LocalDevnetHarnessEnrollmentPlan> {
    this.enrollmentPlanCalls += 1;
    if (this.enrollmentPlanKind === "reused") {
      return {
        kind: "reused",
        creatorAuthority: input.creatorAuthority,
        credentialAddress: CREDENTIAL,
        schemaAddress: SCHEMA,
      };
    }
    return {
      kind: "transaction",
      planId: ENROLLMENT_PLAN_ID,
      creatorAuthority: input.creatorAuthority,
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
      unsignedTransactionBase64: SIGNED_TRANSACTION,
    };
  }

  async completeEnrollment(input: {
    creatorAuthority: string;
    planId: string;
    signedTransactionBase64: string;
  }): Promise<LocalDevnetHarnessEnrollmentResult> {
    this.enrollmentCompleteCalls += 1;
    assert.equal(input.signedTransactionBase64, SIGNED_TRANSACTION);
    return {
      state: "confirmed",
      planId: input.planId,
      creatorAuthority: input.creatorAuthority,
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
      transactionSignature: TRANSACTION_SIGNATURE,
    };
  }

  async getEnrollmentStatus(input: {
    creatorAuthority: string;
    planId: string;
  }): Promise<LocalDevnetHarnessEnrollmentStatus> {
    this.enrollmentStatusCalls += 1;
    const hasSignature =
      this.enrollmentStatusState === "submitted" ||
      this.enrollmentStatusState === "confirmed";
    return {
      state: this.enrollmentStatusState,
      planId: input.planId,
      creatorAuthority: input.creatorAuthority,
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
      ...(hasSignature ? { transactionSignature: TRANSACTION_SIGNATURE } : {}),
    };
  }

  async beginAttestation(input: {
    creatorAuthority: string;
    request: ProvenanceRequestV1;
  }): Promise<LocalDevnetHarnessAttestationPlan> {
    this.attestationBeginCalls += 1;
    return {
      planId: ATTESTATION_PLAN_ID,
      requestId: input.request.requestId,
      creatorAuthority: input.creatorAuthority,
      credentialAddress: CREDENTIAL,
      schemaAddress: SCHEMA,
      attestationAddress: ATTESTATION,
      unsignedTransactionBase64: SIGNED_TRANSACTION,
      messageSha256: "22".repeat(32),
      expiryUnixSeconds: this.expiryUnixSeconds,
    };
  }

  async completeAttestation(input: {
    creatorAuthority: string;
    planId: string;
    signedTransactionBase64: string;
  }): Promise<LocalDevnetHarnessAttestationStatus> {
    this.attestationCompleteCalls += 1;
    assert.equal(input.signedTransactionBase64, SIGNED_TRANSACTION);
    return this.attestationStatus(input, this.completionState);
  }

  async getAttestationStatus(input: {
    creatorAuthority: string;
    planId: string;
  }): Promise<LocalDevnetHarnessAttestationStatus> {
    this.attestationStatusCalls += 1;
    return this.attestationStatus(input, this.statusState);
  }

  private attestationStatus(
    input: { creatorAuthority: string; planId: string },
    state: "submitted" | "confirmed",
  ): LocalDevnetHarnessAttestationStatus {
    return {
      state,
      planId: input.planId,
      requestId: provenanceRequest().requestId,
      creatorAuthority: input.creatorAuthority,
      attestationAddress: ATTESTATION,
      transactionSignature: TRANSACTION_SIGNATURE,
    };
  }
}

interface HarnessServer {
  readonly server: Server;
  readonly port: number;
  readonly flow: MockFlow;
}

interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

async function startHarness(flow = new MockFlow()): Promise<HarnessServer> {
  const middleware = createLocalDevnetHarnessMiddleware(flow);
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end("outside");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("server did not bind");
  return { server, port: bound.port, flow };
}

async function stopHarness(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function call(
  harness: HarnessServer,
  input: Readonly<{
    path: string;
    method?: string;
    body?: string;
    cookie?: string;
    csrf?: string;
    host?: string;
    origin?: string | null;
    fetchSite?: string;
    contentType?: string;
    includeLength?: boolean;
  }>,
): Promise<HttpResult> {
  const body = input.body;
  const headers: Record<string, string | number> = {
    Host: input.host ?? LOCAL_DEVNET_HARNESS_HOST,
    "Sec-Fetch-Site": input.fetchSite ?? "same-origin",
  };
  if (input.origin !== null) {
    headers.Origin = input.origin ?? LOCAL_DEVNET_HARNESS_ORIGIN;
  }
  if (input.cookie !== undefined) headers.Cookie = input.cookie;
  if (input.csrf !== undefined) headers[LOCAL_DEVNET_HARNESS_CSRF_HEADER] = input.csrf;
  if (body !== undefined) {
    headers["Content-Type"] = input.contentType ?? "application/json";
    if (input.includeLength !== false) headers["Content-Length"] = Buffer.byteLength(body);
  }

  return await new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: harness.port,
        path: input.path,
        method: input.method ?? (body === undefined ? "GET" : "POST"),
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function cookieFrom(result: HttpResult): string {
  const raw = result.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

function csrfFrom(result: HttpResult): string {
  const value = result.json.csrfToken;
  assert.equal(typeof value, "string");
  return value as string;
}

async function session(harness: HarnessServer): Promise<{
  cookie: string;
  csrf: string;
}> {
  const result = await call(harness, {
    path: "/__local-devnet/session",
    origin: null,
  });
  assert.equal(result.status, 200);
  return { cookie: cookieFrom(result), csrf: csrfFrom(result) };
}

async function postJson(
  harness: HarnessServer,
  auth: { cookie: string; csrf: string },
  path: string,
  value: unknown,
): Promise<HttpResult> {
  return call(harness, {
    path,
    method: "POST",
    body: JSON.stringify(value),
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
}

async function connect(
  harness: HarnessServer,
  auth: { cookie: string; csrf: string },
  creatorAuthority = CREATOR,
): Promise<HttpResult> {
  return postJson(harness, auth, "/__local-devnet/connect", {
    creatorAuthority,
  });
}

test("session is opaque, HttpOnly, one-process-only, pinned, and non-cacheable", async () => {
  const harness = await startHarness();
  try {
    const first = await call(harness, {
      path: "/__local-devnet/session",
      origin: null,
      fetchSite: "none",
    });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.json).sort(), [
      "contract",
      "csrfToken",
      "genesisHash",
      "network",
      "sasProgramId",
      "sponsorPayer",
      "version",
    ]);
    assert.equal(first.json.network, "solana:devnet");
    assert.equal(first.json.genesisHash, DEVNET_GENESIS_HASH);
    assert.equal(first.json.sasProgramId, SAS_PROGRAM_ID);
    assert.equal(first.json.sponsorPayer, SPONSOR);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(first.headers["access-control-allow-origin"], undefined);
    const rawCookie = first.headers["set-cookie"];
    assert.match(Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!, /HttpOnly/u);
    assert.match(Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!, /SameSite=Strict/u);
    assert.doesNotMatch(first.text, new RegExp(cookieFrom(first).split("=")[1]!, "u"));

    const resumed = await call(harness, {
      path: "/__local-devnet/session",
      cookie: cookieFrom(first),
      origin: null,
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers["set-cookie"], undefined);
    assert.equal(resumed.json.csrfToken, first.json.csrfToken);

    const secondSession = await call(harness, {
      path: "/__local-devnet/session",
      origin: null,
    });
    assert.equal(secondSession.status, 409);
  } finally {
    await stopHarness(harness.server);
  }
});

test("a fresh process rotates a stale HttpOnly session cookie", async () => {
  const harness = await startHarness();
  try {
    const staleCookie = `${LOCAL_DEVNET_HARNESS_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const fresh = await call(harness, {
      path: "/__local-devnet/session",
      cookie: staleCookie,
      origin: null,
      fetchSite: "none",
    });

    assert.equal(fresh.status, 200);
    const rotatedCookie = cookieFrom(fresh);
    assert.notEqual(rotatedCookie, staleCookie);
    const rawCookie = fresh.headers["set-cookie"];
    assert.match(Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!, /HttpOnly/u);
    assert.match(Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!, /SameSite=Strict/u);

    const resumed = await call(harness, {
      path: "/__local-devnet/session",
      cookie: rotatedCookie,
      origin: null,
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers["set-cookie"], undefined);
    assert.equal(resumed.json.csrfToken, fresh.json.csrfToken);
  } finally {
    await stopHarness(harness.server);
  }
});

test("boundary rejects wrong Host, Origin, Fetch Metadata, method, and path", async () => {
  const harness = await startHarness();
  try {
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/session",
        host: "localhost:4173",
        origin: null,
      })).status,
      403,
    );
    const auth = await session(harness);
    const connectBody = JSON.stringify({ creatorAuthority: CREATOR });
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "POST",
        body: connectBody,
        cookie: auth.cookie,
        csrf: auth.csrf,
        origin: "http://evil.invalid",
      })).status,
      403,
    );
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "POST",
        body: connectBody,
        cookie: auth.cookie,
        csrf: auth.csrf,
        fetchSite: "cross-site",
      })).status,
      403,
    );
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "GET",
        cookie: auth.cookie,
      })).status,
      405,
    );
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/send-transaction",
      })).status,
      404,
    );
    const outside = await call(harness, { path: "/ordinary-page" });
    assert.equal(outside.status, 404);
    assert.equal(outside.text, "outside");
  } finally {
    await stopHarness(harness.server);
  }
});

test("POST requires the exact session, CSRF token, and JSON content type", async () => {
  const harness = await startHarness();
  try {
    const auth = await session(harness);
    const body = JSON.stringify({ creatorAuthority: CREATOR });
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "POST",
        body,
        csrf: auth.csrf,
      })).status,
      401,
    );
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "POST",
        body,
        cookie: auth.cookie,
      })).status,
      403,
    );
    assert.equal(
      (await call(harness, {
        path: "/__local-devnet/connect",
        method: "POST",
        body,
        cookie: auth.cookie,
        csrf: auth.csrf,
        contentType: "application/json; charset=utf-8",
      })).status,
      415,
    );
    assert.equal(harness.flow.connectCalls, 0);
  } finally {
    await stopHarness(harness.server);
  }
});

test("streamed bodies are capped before JSON parsing or flow invocation", async () => {
  const harness = await startHarness();
  try {
    const auth = await session(harness);
    const oversized = JSON.stringify({ creatorAuthority: "x".repeat(1_000) });
    const result = await call(harness, {
      path: "/__local-devnet/connect",
      method: "POST",
      body: oversized,
      cookie: auth.cookie,
      csrf: auth.csrf,
      includeLength: false,
    });
    assert.equal(result.status, 413);
    assert.equal(harness.flow.connectCalls, 0);
  } finally {
    await stopHarness(harness.server);
  }
});

test("one session is permanently bound to one canonical creator", async () => {
  const harness = await startHarness();
  try {
    const auth = await session(harness);
    assert.equal((await connect(harness, auth)).status, 200);
    const mismatch = await connect(harness, auth, OTHER_CREATOR);
    assert.equal(mismatch.status, 409);
    assert.equal(harness.flow.connectCalls, 1);
    const unexpected = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/plan",
      { creatorAuthority: CREATOR, rpcUrl: "https://evil.invalid" },
    );
    assert.equal(unexpected.status, 400);
    assert.equal(harness.flow.enrollmentPlanCalls, 0);
  } finally {
    await stopHarness(harness.server);
  }
});

test("a failed connect does not bind the session to that creator", async () => {
  const flow = new MockFlow();
  flow.throwConnect = new Error("temporary local failure");
  const harness = await startHarness(flow);
  try {
    const auth = await session(harness);
    assert.equal((await connect(harness, auth, CREATOR)).status, 503);
    flow.throwConnect = undefined;
    assert.equal((await connect(harness, auth, OTHER_CREATOR)).status, 200);
    assert.equal(flow.connectCalls, 2);
  } finally {
    await stopHarness(harness.server);
  }
});

test("enrollment uses one active plan and rejects completion replay", async () => {
  const flow = new MockFlow();
  flow.enrollmentPlanKind = "transaction";
  const harness = await startHarness(flow);
  try {
    const auth = await session(harness);
    assert.equal((await connect(harness, auth)).status, 200);
    const plan = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/plan",
      { creatorAuthority: CREATOR },
    );
    assert.equal(plan.status, 200);
    assert.equal(plan.json.planId, ENROLLMENT_PLAN_ID);
    const completeBody = {
      creatorAuthority: CREATOR,
      planId: ENROLLMENT_PLAN_ID,
      signedTransactionBase64: SIGNED_TRANSACTION,
    };
    const completed = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/complete",
      completeBody,
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.json.transactionSignature, TRANSACTION_SIGNATURE);
    const recoveredConfirmation = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      {
        creatorAuthority: CREATOR,
        planId: ENROLLMENT_PLAN_ID,
      },
    );
    assert.equal(recoveredConfirmation.status, 200);
    assert.equal(recoveredConfirmation.json.state, "confirmed");
    const replay = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/complete",
      completeBody,
    );
    assert.equal(replay.status, 409);
    assert.equal(flow.enrollmentCompleteCalls, 1);
  } finally {
    await stopHarness(harness.server);
  }
});

test("enrollment status is plan-bound and clears only after confirmation", async () => {
  const flow = new MockFlow();
  flow.enrollmentPlanKind = "transaction";
  flow.enrollmentStatusState = "prepared";
  const harness = await startHarness(flow);
  try {
    const auth = await session(harness);
    assert.equal((await connect(harness, auth)).status, 200);
    assert.equal(
      (
        await postJson(harness, auth, "/__local-devnet/enrollment/plan", {
          creatorAuthority: CREATOR,
        })
      ).status,
      200,
    );

    const statusBody = {
      creatorAuthority: CREATOR,
      planId: ENROLLMENT_PLAN_ID,
    };
    const prepared = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      statusBody,
    );
    assert.equal(prepared.status, 200);
    assert.equal(prepared.json.state, "prepared");
    assert.equal(prepared.json.transactionSignature, undefined);

    const wrongPlan = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      { ...statusBody, planId: "W".repeat(22) },
    );
    assert.equal(wrongPlan.status, 409);

    flow.enrollmentStatusState = "submitted";
    const submitted = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      statusBody,
    );
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.state, "submitted");
    assert.equal(submitted.json.transactionSignature, TRANSACTION_SIGNATURE);

    flow.enrollmentStatusState = "confirmed";
    const confirmed = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      statusBody,
    );
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.state, "confirmed");
    assert.equal(flow.enrollmentCompleteCalls, 0);

    const afterConfirmation = await postJson(
      harness,
      auth,
      "/__local-devnet/enrollment/status",
      statusBody,
    );
    assert.equal(afterConfirmation.status, 200);
    assert.equal(afterConfirmation.json.state, "confirmed");
  } finally {
    await stopHarness(harness.server);
  }
});

test("strict nested request validation rejects legacy-compatible extra fields", async () => {
  const harness = await startHarness();
  try {
    const auth = await session(harness);
    await connect(harness, auth);
    const request = provenanceRequest() as unknown as Record<string, unknown>;
    const commitment = request.commitment as Record<string, unknown>;
    commitment.extra = "legacy-compatible-but-not-wire-safe";
    const result = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/begin",
      { creatorAuthority: CREATOR, request },
    );
    assert.equal(result.status, 400);
    assert.equal(harness.flow.attestationBeginCalls, 0);
  } finally {
    await stopHarness(harness.server);
  }
});

test("attestation plan expiry must be a positive canonical decimal", async () => {
  const flow = new MockFlow();
  flow.expiryUnixSeconds = "0";
  const harness = await startHarness(flow);
  try {
    const auth = await session(harness);
    await connect(harness, auth);
    const result = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/begin",
      { creatorAuthority: CREATOR, request: provenanceRequest() },
    );
    assert.equal(result.status, 503);
    assert.equal(flow.attestationBeginCalls, 1);
  } finally {
    await stopHarness(harness.server);
  }
});

test("attestation completion is one-shot and status is bound to its plan", async () => {
  const harness = await startHarness();
  try {
    const auth = await session(harness);
    await connect(harness, auth);
    const begin = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/begin",
      { creatorAuthority: CREATOR, request: provenanceRequest() },
    );
    assert.equal(begin.status, 200);
    assert.equal(begin.json.planId, ATTESTATION_PLAN_ID);
    const completion = {
      creatorAuthority: CREATOR,
      planId: ATTESTATION_PLAN_ID,
      signedTransactionBase64: SIGNED_TRANSACTION,
    };
    assert.equal(
      (await postJson(
        harness,
        auth,
        "/__local-devnet/attestation/complete",
        completion,
      )).status,
      200,
    );
    assert.equal(
      (await postJson(
        harness,
        auth,
        "/__local-devnet/attestation/complete",
        completion,
      )).status,
      409,
    );
    const wrongStatus = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/status",
      { creatorAuthority: CREATOR, planId: "Z".repeat(22) },
    );
    assert.equal(wrongStatus.status, 409);
    const status = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/status",
      { creatorAuthority: CREATOR, planId: ATTESTATION_PLAN_ID },
    );
    assert.equal(status.status, 200);
    assert.equal(status.json.state, "confirmed");
    assert.equal(harness.flow.attestationCompleteCalls, 1);
  } finally {
    await stopHarness(harness.server);
  }
});

test("one confirmed issuance prevents a second begin", async () => {
  const flow = new MockFlow();
  flow.completionState = "confirmed";
  const harness = await startHarness(flow);
  try {
    const auth = await session(harness);
    await connect(harness, auth);
    await postJson(harness, auth, "/__local-devnet/attestation/begin", {
      creatorAuthority: CREATOR,
      request: provenanceRequest(),
    });
    const complete = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/complete",
      {
        creatorAuthority: CREATOR,
        planId: ATTESTATION_PLAN_ID,
        signedTransactionBase64: SIGNED_TRANSACTION,
      },
    );
    assert.equal(complete.status, 200);
    const second = await postJson(
      harness,
      auth,
      "/__local-devnet/attestation/begin",
      { creatorAuthority: CREATOR, request: provenanceRequest() },
    );
    assert.equal(second.status, 409);
    assert.equal(flow.attestationBeginCalls, 1);
  } finally {
    await stopHarness(harness.server);
  }
});

test("flow errors are redacted and response DTOs reject secrets or final wire", async () => {
  const failingFlow = new MockFlow();
  failingFlow.throwConnect = new Error(
    "privateKeyBase64=TOP_SECRET sponsorSecret=DO_NOT_EXPOSE",
  );
  const failingHarness = await startHarness(failingFlow);
  try {
    const auth = await session(failingHarness);
    const result = await connect(failingHarness, auth);
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.text, /TOP_SECRET|privateKeyBase64|sponsorSecret/u);
  } finally {
    await stopHarness(failingHarness.server);
  }

  const leakingFlow = new MockFlow();
  leakingFlow.connectResultExtension = {
    sponsorSecret: "TOP_SECRET",
    finalTransactionBase64: "AQ==",
  };
  const leakingHarness = await startHarness(leakingFlow);
  try {
    const auth = await session(leakingHarness);
    const result = await connect(leakingHarness, auth);
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.text, /TOP_SECRET|sponsorSecret|finalTransaction/u);
  } finally {
    await stopHarness(leakingHarness.server);
  }
});

test("dedicated Vite config is fixed to IPv4 loopback port 4173 and strictPort", () => {
  const config = createLocalDevnetViteConfig(new MockFlow());
  const staticRoot = fileURLToPath(
    new URL("../dist/devnet-web/", import.meta.url),
  );
  assert.deepEqual(config.server, {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    cors: false,
    fs: {
      strict: true,
      allow: [staticRoot],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.local/**",
      ],
    },
  });
  assert.equal(config.root, staticRoot);
  assert.equal(LOCAL_DEVNET_HARNESS_HOST, "127.0.0.1:4173");
  assert.equal(LOCAL_DEVNET_HARNESS_COOKIE, "velorn_local_devnet_session");
  assert.match(LOCAL_DEVNET_HARNESS_CSP, /connect-src 'self'/u);
  assert.match(LOCAL_DEVNET_HARNESS_CSP, /frame-ancestors 'none'/u);

  const plugin = (
    Array.isArray(config.plugins) ? config.plugins[0] : undefined
  ) as Plugin | undefined;
  assert.ok(plugin && typeof plugin === "object");
  assert.equal(typeof plugin.configResolved, "function");
  assert.equal(typeof plugin.configureServer, "function");
  assert.equal(plugin.transformIndexHtml, undefined);
  const assertResolved = plugin.configResolved as (config: unknown) => void;
  assert.doesNotThrow(() =>
    assertResolved({
      server: {
        host: "127.0.0.1",
        port: 4173,
        strictPort: true,
        cors: false,
      },
    }),
  );
  assert.throws(
    () =>
      assertResolved({
        server: {
          host: "0.0.0.0",
          port: 4173,
          strictPort: true,
          cors: false,
        },
      }),
    /may not be overridden/u,
  );
  const installed: Array<(
    request: unknown,
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) => void> = [];
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: {
      use(middleware: (typeof installed)[number]) {
        installed.push(middleware);
      },
    },
  });
  assert.equal(installed.length, 2);
  const headers = new Map<string, string>();
  let continued = false;
  installed[0]!(
    {},
    { setHeader: (name, value) => headers.set(name, value) },
    () => {
      continued = true;
    },
  );
  assert.equal(headers.get("Content-Security-Policy"), LOCAL_DEVNET_HARNESS_CSP);
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(continued, true);
});
