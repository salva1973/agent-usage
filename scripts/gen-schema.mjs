import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { UsageReportSchema } from "../dist/domain/reportSchema.js";

const directory = new URL("../schema/", import.meta.url);
// Input schemas allow unknown fields, matching the contract's consumer policy.
const schema = z.toJSONSchema(UsageReportSchema, { target: "draft-2020-12", io: "input" });
await mkdir(directory, { recursive: true });
await writeFile(new URL("usage-report.v1.schema.json", directory), `${JSON.stringify(schema, null, 2)}\n`);
