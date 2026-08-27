import { readFile } from "node:fs/promises";

import { readPublicReceipt, verifyPublicReceipt } from "./verify.js";

async function main(): Promise<void> {
  const [receiptPath, mediaPath, manifestPath] = process.argv.slice(2);
  if (!receiptPath) {
    throw new Error(
      "Usage: npm run verify -- <receipt.json> [media-file provenance-manifest.json]",
    );
  }
  if ((mediaPath && !manifestPath) || (!mediaPath && manifestPath)) {
    throw new Error("Provide both the media file and manifest, or neither");
  }

  const receipt = await readPublicReceipt(receiptPath);
  let mediaBytes: Uint8Array | undefined;
  let manifest: unknown;
  if (mediaPath && manifestPath) {
    mediaBytes = await readFile(mediaPath);
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  }

  const result = await verifyPublicReceipt(receipt, {
    ...(mediaBytes !== undefined && manifest !== undefined
      ? { mediaBytes, manifest }
      : {}),
    ...(process.env.SAS_RPC_URL ? { rpcUrl: process.env.SAS_RPC_URL } : {}),
    ...(process.env.SAS_WSS_URL
      ? { websocketUrl: process.env.SAS_WSS_URL }
      : {}),
  });

  for (const [name, passed] of Object.entries(result.checks)) {
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  }
  if (!result.valid) {
    process.exitCode = 1;
    return;
  }
  console.log("Receipt is valid against the current Devnet accounts.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
