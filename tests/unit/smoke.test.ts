import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { SCHEMA_VERSION } from "../../src/index.js";
import { version } from "../../src/version.js";

test("the scaffold exposes schema v1 and the package version", () => {
  const packageInfo: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  expect(SCHEMA_VERSION).toBe(1);
  expect(packageInfo).toMatchObject({ version, engines: { node: ">=22" } });
});
