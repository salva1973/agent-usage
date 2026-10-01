import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Build the current source once before any test can spawn the compiled CLI. */
export function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit" });
}
