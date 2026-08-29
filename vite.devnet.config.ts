import { randomBytes as nodeRandomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type UserConfig } from "vite";

import { createLocalDevnetFlowService } from "./src/local-devnet-flow.js";
import {
  createLocalDevnetHarnessMiddleware,
  LOCAL_DEVNET_HARNESS_HOST,
  type LocalDevnetHarnessFlowService,
} from "./src/local-devnet-harness.js";
import { createHardPinnedLocalDevnetKitBroadcastFacade } from "./src/local-devnet-kit-broadcast.js";
import { createHardPinnedLocalDevnetKitRpcFacade } from "./src/local-devnet-kit-rpc.js";
import { loadSecureLocalDevnetSponsor } from "./src/local-devnet-secret.js";

export const LOCAL_DEVNET_HARNESS_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOCAL_DEVNET_PROJECT_ROOT = fileURLToPath(
  new URL(".", import.meta.url),
);
const LOCAL_DEVNET_STATIC_ROOT = fileURLToPath(
  new URL("dist/devnet-web/", import.meta.url),
);

/**
 * Build the isolated loopback config around an already-composed semantic flow.
 * The normal Vite config and dev:web command remain untouched.
 */
export function createLocalDevnetViteConfig(
  flow: LocalDevnetHarnessFlowService,
): UserConfig {
  const middleware = createLocalDevnetHarnessMiddleware(flow);
  const plugin: Plugin = {
    name: "velorn-local-devnet-harness",
    apply: "serve",
    configResolved(config) {
      if (
        config.server.host !== "127.0.0.1" ||
        config.server.port !== 4173 ||
        config.server.strictPort !== true ||
        config.server.cors !== false
      ) {
        throw new Error(
          "Local Devnet harness server settings may not be overridden",
        );
      }
    },
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        response.setHeader("Content-Security-Policy", LOCAL_DEVNET_HARNESS_CSP);
        response.setHeader("X-Frame-Options", "DENY");
        next();
      });
      server.middlewares.use(middleware);
    },
  };

  return {
    root: LOCAL_DEVNET_STATIC_ROOT,
    base: "./",
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      cors: false,
      fs: {
        strict: true,
        allow: [LOCAL_DEVNET_STATIC_ROOT],
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
    },
    plugins: [plugin],
  };
}

/**
 * The explicit dev:devnet command is the only entry point that installs the
 * real local flow. Constructing the two hard-pinned Kit facades does not make
 * a network request. The sponsor seed is loaded once into the Node process and
 * never crosses the narrow semantic flow or HTTP response boundary.
 */
export default defineConfig(async ({ command, isPreview }) => {
  if (command !== "serve" || isPreview) {
    throw new Error(
      "The local Devnet harness may only run as the explicit development server",
    );
  }
  const flow = await createLocalDevnetFlowService({
    rpc: createHardPinnedLocalDevnetKitRpcFacade(),
    broadcast: createHardPinnedLocalDevnetKitBroadcastFacade(),
    loadSponsorSigner: () =>
      loadSecureLocalDevnetSponsor(LOCAL_DEVNET_PROJECT_ROOT),
    nowUnixSeconds: () => BigInt(Math.floor(Date.now() / 1_000)),
    randomBytes: (byteLength) =>
      Uint8Array.from(nodeRandomBytes(byteLength)),
  });
  return createLocalDevnetViteConfig(flow);
});

if (LOCAL_DEVNET_HARNESS_HOST !== "127.0.0.1:4173") {
  throw new Error("Local Devnet harness host is not pinned");
}
