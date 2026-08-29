import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";

const LOCAL_DIRECTORY_NAME = ".local";
const SPONSOR_FILE_NAME = "devnet-payer.json";
const MAX_SPONSOR_FILE_BYTES = 1_024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface StoredDevnetSponsor {
  readonly format: "velorn-devnet-ed25519-seed-v1";
  readonly cluster: "devnet";
  readonly privateKeyBase64: string;
}

export class LocalDevnetSecretError extends Error {
  constructor(message: string) {
    super(`Local Devnet sponsor rejected: ${message}`);
    this.name = "LocalDevnetSecretError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetSecretError(message);
}

function currentUserId(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    fail("secure POSIX ownership checks are unavailable");
  }
  return uid;
}

function assertMode(actual: number, expected: number, label: string): void {
  if ((actual & 0o7777) !== expected) {
    fail(`${label} permissions must be ${expected.toString(8)}`);
  }
}

function parseStoredSponsor(text: string): StoredDevnetSponsor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("wallet file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("wallet file must contain an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "cluster" ||
    keys[1] !== "format" ||
    keys[2] !== "privateKeyBase64"
  ) {
    fail("wallet file contains unsupported fields");
  }
  if (
    record.format !== "velorn-devnet-ed25519-seed-v1" ||
    record.cluster !== "devnet" ||
    typeof record.privateKeyBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.privateKeyBase64)
  ) {
    fail("wallet file has an unsupported format");
  }
  const seed = Buffer.from(record.privateKeyBase64, "base64");
  const canonical = seed.toString("base64") === record.privateKeyBase64;
  seed.fill(0);
  if (!canonical) fail("wallet seed is not canonical base64");
  return record as unknown as StoredDevnetSponsor;
}

/**
 * Load the one fixed, disposable Devnet sponsor seed from this repository.
 *
 * This function is intentionally POSIX-only and local-harness-only. It never
 * accepts a caller-selected wallet path, refuses a final-component symlink,
 * rechecks the private-directory identity, and returns no raw seed. The caller
 * must supply a trusted canonical repository root rather than an attacker-
 * controlled path. String copies held by the JavaScript runtime cannot be
 * forcibly erased; mutable seed buffers are cleared on every exit path.
 */
export async function loadSecureLocalDevnetSponsor(
  projectRoot: string,
): Promise<KeyPairSigner> {
  if (!path.isAbsolute(projectRoot)) {
    fail("project root must be an absolute trusted path");
  }
  const uid = currentUserId();
  const localDirectory = path.join(projectRoot, LOCAL_DIRECTORY_NAME);
  const sponsorPath = path.join(localDirectory, SPONSOR_FILE_NAME);

  let directoryStatus;
  try {
    directoryStatus = await lstat(localDirectory);
  } catch {
    fail("private wallet directory is missing or unreadable");
  }
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    fail("private wallet directory must be a real directory");
  }
  if (directoryStatus.uid !== uid) {
    fail("private wallet directory must be owned by the current user");
  }
  assertMode(directoryStatus.mode, DIRECTORY_MODE, "private wallet directory");

  let fileStatus;
  try {
    fileStatus = await lstat(sponsorPath);
  } catch {
    fail("wallet file is missing or unreadable");
  }
  if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
    fail("wallet path must be a real regular file");
  }
  if (fileStatus.uid !== uid) {
    fail("wallet file must be owned by the current user");
  }
  assertMode(fileStatus.mode, FILE_MODE, "wallet file");
  if (fileStatus.size <= 0 || fileStatus.size > MAX_SPONSOR_FILE_BYTES) {
    fail("wallet file size is outside the local harness limit");
  }

  let handle;
  try {
    handle = await open(
      sponsorPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    fail("wallet file could not be opened without following links");
  }

  let text: string;
  try {
    const openedStatus = await handle.stat();
    if (
      !openedStatus.isFile() ||
      openedStatus.uid !== uid ||
      openedStatus.dev !== fileStatus.dev ||
      openedStatus.ino !== fileStatus.ino
    ) {
      fail("wallet file changed during secure open");
    }
    assertMode(openedStatus.mode, FILE_MODE, "opened wallet file");
    if (
      openedStatus.size <= 0 ||
      openedStatus.size > MAX_SPONSOR_FILE_BYTES
    ) {
      fail("opened wallet file size is outside the local harness limit");
    }
    const readBuffer = Buffer.alloc(MAX_SPONSOR_FILE_BYTES + 1);
    try {
      const { bytesRead } = await handle.read(
        readBuffer,
        0,
        readBuffer.byteLength,
        0,
      );
      if (
        bytesRead <= 0 ||
        bytesRead > MAX_SPONSOR_FILE_BYTES ||
        bytesRead !== openedStatus.size
      ) {
        fail("wallet file changed size during secure read");
      }
      const [afterReadStatus, afterReadDirectory] = await Promise.all([
        handle.stat(),
        lstat(localDirectory),
      ]);
      if (
        !afterReadStatus.isFile() ||
        afterReadStatus.uid !== uid ||
        afterReadStatus.dev !== openedStatus.dev ||
        afterReadStatus.ino !== openedStatus.ino ||
        afterReadStatus.size !== openedStatus.size ||
        afterReadStatus.mtimeMs !== openedStatus.mtimeMs ||
        afterReadStatus.ctimeMs !== openedStatus.ctimeMs
      ) {
        fail("wallet file changed during secure read");
      }
      if (
        afterReadDirectory.isSymbolicLink() ||
        !afterReadDirectory.isDirectory() ||
        afterReadDirectory.uid !== uid ||
        afterReadDirectory.dev !== directoryStatus.dev ||
        afterReadDirectory.ino !== directoryStatus.ino
      ) {
        fail("private wallet directory changed during secure read");
      }
      assertMode(
        afterReadDirectory.mode,
        DIRECTORY_MODE,
        "private wallet directory",
      );
      text = readBuffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      readBuffer.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof LocalDevnetSecretError) throw error;
    fail("wallet file could not be read securely");
  } finally {
    try {
      await handle.close();
    } catch {
      fail("wallet file could not be closed securely");
    }
  }

  const stored = parseStoredSponsor(text);
  const seed = Buffer.from(stored.privateKeyBase64, "base64");
  if (seed.byteLength !== 32) {
    seed.fill(0);
    fail("wallet seed must contain exactly 32 bytes");
  }
  try {
    try {
      return await createKeyPairSignerFromPrivateKeyBytes(seed);
    } catch {
      fail("wallet seed could not create a non-extractable signer");
    }
  } finally {
    seed.fill(0);
  }
}
