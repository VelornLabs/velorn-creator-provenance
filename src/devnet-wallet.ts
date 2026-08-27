import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";

interface StoredDevnetWallet {
  format: "velorn-devnet-ed25519-seed-v1";
  cluster: "devnet";
  privateKeyBase64: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseStoredWallet(value: unknown): StoredDevnetWallet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Devnet wallet file must contain an object");
  }
  const candidate = value as Partial<StoredDevnetWallet>;
  if (
    candidate.format !== "velorn-devnet-ed25519-seed-v1" ||
    candidate.cluster !== "devnet" ||
    typeof candidate.privateKeyBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.privateKeyBase64)
  ) {
    throw new TypeError("Devnet wallet file has an unsupported format");
  }
  const decoded = Buffer.from(candidate.privateKeyBase64, "base64");
  if (decoded.byteLength !== 32) {
    throw new TypeError("Devnet wallet seed must be exactly 32 bytes");
  }
  return candidate as StoredDevnetWallet;
}

export async function loadDevnetWallet(filePath: string): Promise<KeyPairSigner> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const stored = parseStoredWallet(parsed);
  return createKeyPairSignerFromPrivateKeyBytes(
    Buffer.from(stored.privateKeyBase64, "base64"),
  );
}

export async function createDevnetWallet(filePath: string): Promise<KeyPairSigner> {
  const seed = randomBytes(32);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const stored: StoredDevnetWallet = {
    format: "velorn-devnet-ed25519-seed-v1",
    cluster: "devnet",
    privateKeyBase64: seed.toString("base64"),
  };
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return signer;
}

export async function loadOptionalDevnetWallet(
  filePath: string,
): Promise<KeyPairSigner | null> {
  try {
    return await loadDevnetWallet(filePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}
