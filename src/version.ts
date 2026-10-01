import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);
const packageInfo = z.object({ version: z.string() }).parse(
  require("../package.json") as unknown,
);

/** Package version, read from package.json in both source and built modules. */
export const version = packageInfo.version;
