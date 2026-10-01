import { configDefaults, defineConfig } from "vitest/config";

// Narrow tooling exception approved in SPEC.md §16: Vite requires this export.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.argv.includes("tests/live") ? [] : ["tests/live/**"]),
    ],
  },
});
