const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
  throw new Error("App root is missing");
}

root.textContent = "Loading the local Devnet checkpoint…";

interface FailedBrowserModule {
  readonly label: string;
  readonly message: string;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/gu, " ").slice(0, 240)
    : "Unknown browser module error";
}

async function identifyFailedBrowserModule(): Promise<FailedBrowserModule> {
  const checks: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["public contracts", () => import("../../src/contracts.js")],
    ["browser hashing", () => import("./browser-hash.js")],
    ["wallet discovery", () => import("./wallet-standard.js")],
    ["wallet signing", () => import("./devnet-wallet-signing.js")],
    ["exact-wire validation", () => import("./exact-wallet-wire.js")],
    ["local harness client", () => import("./local-devnet-client.js")],
    ["walkthrough styles", () => import("./local-devnet-styles.css")],
  ];
  for (const [label, load] of checks) {
    try {
      await load();
    } catch (error: unknown) {
      return { label, message: safeErrorMessage(error) };
    }
  }
  return { label: "walkthrough entry", message: "Entry initialization failed" };
}

void import("./local-devnet-main.js").catch(async (error: unknown) => {
  const shell = document.createElement("main");
  shell.style.cssText =
    "box-sizing:border-box;max-width:720px;margin:64px auto;padding:32px;color:#f5eee7;background:#171311;border:1px solid #6e4933;border-radius:16px;font:16px/1.55 system-ui,sans-serif";
  const heading = document.createElement("h1");
  heading.textContent = "The local Devnet checkpoint could not load.";
  const copy = document.createElement("p");
  copy.textContent =
    "No wallet request or Solana transaction was started. Refresh after the local browser compatibility issue is corrected.";
  const detail = document.createElement("p");
  const failedModule = await identifyFailedBrowserModule();
  const message = safeErrorMessage(error);
  detail.textContent = `Technical detail (${failedModule.label}): ${failedModule.message}; entry: ${message}`;
  detail.style.overflowWrap = "anywhere";
  shell.append(heading, copy, detail);
  root.replaceChildren(shell);
});
