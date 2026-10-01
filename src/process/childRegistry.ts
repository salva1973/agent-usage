import type { ChildProcess } from "node:child_process";

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface ChildGroup {
  closed: Promise<ProcessExit>;
  terminate(): Promise<void>;
  release(): Promise<void>;
}

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of liveGroups) {
      try {
        signalGroup(pid, "SIGKILL");
      } catch {
        // Exit hooks cannot await recovery and must never print unredacted errors.
      }
    }
  });
}

async function waitForGroupExit(pid: number): Promise<void> {
  const deadline = performance.now() + 1000;
  while (signalGroup(pid, 0) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Track a detached child and retain its group until descendants are cleaned up. */
export function registerChildGroup(child: ChildProcess): ChildGroup {
  installExitHook();
  const pid = child.pid;
  if (pid !== undefined) liveGroups.add(pid);
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let termination: Promise<void> | undefined;
  let released = false;

  function terminate(): Promise<void> {
    if (released) return Promise.resolve();
    termination ??= (async () => {
      if (pid !== undefined && signalGroup(pid, "SIGTERM")) {
        await waitForGroupExit(pid);
        signalGroup(pid, "SIGKILL");
      }
      await closed;
      if (pid !== undefined) liveGroups.delete(pid);
      released = true;
    })();
    return termination;
  }

  child.once("exit", () => {
    // Descendants can keep inherited pipes open after their parent exits.
    // Clean the group at exit rather than waiting indefinitely for close.
    if (pid !== undefined && signalGroup(pid, 0)) void terminate().catch(() => {});
  });

  return {
    closed,
    terminate,
    async release(): Promise<void> {
      if (termination !== undefined) return termination;
      if (pid !== undefined && signalGroup(pid, 0)) return terminate();
      if (pid !== undefined) liveGroups.delete(pid);
      released = true;
    },
  };
}
