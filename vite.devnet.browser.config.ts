import { defineConfig } from "vite";

/** Builds only the browser half of the isolated local Devnet walkthrough. */
export default defineConfig(({ command }) => {
  if (command !== "build") {
    throw new Error("The local Devnet browser config may only build");
  }
  return {
    root: ".",
    base: "./",
    build: {
      outDir: "dist/devnet-web",
      emptyOutDir: true,
    },
  };
});
