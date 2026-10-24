export type BootstrapStep = "migration" | "storage" | "preflight" | "server";
export class BootstrapFailure extends Error {
  constructor(
    public readonly step: BootstrapStep,
    cause: unknown,
  ) {
    super("Deployment initialization failed", { cause });
  }
}
// The server never becomes reachable before initialization and preflight pass.
export async function runBootstrap(
  operations: Record<BootstrapStep, () => Promise<unknown>>,
) {
  for (const step of ["migration", "storage", "preflight", "server"] as const) {
    try {
      await operations[step]();
    } catch (error) {
      throw new BootstrapFailure(step, error);
    }
  }
}
