import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDevnetWallet } from "./devnet-wallet.js";

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const walletPath = path.join(projectRoot, ".local", "devnet-payer.json");
  const signer = await createDevnetWallet(walletPath);
  console.log("Created a disposable Devnet-only wallet.");
  console.log(`Public address: ${signer.address}`);
  console.log(`Secret file: ${walletPath}`);
  console.log("The secret was not printed. This path is gitignored and mode 0600.");
  console.log("Never send Mainnet SOL to this address.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not create Devnet wallet: ${message}`);
  process.exitCode = 1;
});
