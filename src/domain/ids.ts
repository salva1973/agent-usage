import { makeIssue } from "./issues.js";
import type { ProviderIssue } from "./model.js";

/** Lowercase, replace non-ASCII-alphanumeric runs with underscores, and trim. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Allocate unique ids within one report, suffixing later collisions. */
export class LimitIdAllocator {
  private readonly used = new Set<string>();
  private readonly counts = new Map<string, number>();

  /** Reserve an id, appending #2, #3, ... and a warning on collisions. */
  allocate(id: string, warnings: ProviderIssue[] = []): string {
    let count = this.counts.get(id) ?? 1;
    let allocated = id;
    while (this.used.has(allocated)) {
      count += 1;
      allocated = `${id}#${count}`;
    }
    this.counts.set(id, count);
    this.used.add(allocated);
    if (allocated !== id) {
      warnings.push(makeIssue("duplicate_limit_id", `Duplicate limit id ${id}; assigned ${allocated}.`));
    }
    return allocated;
  }
}
