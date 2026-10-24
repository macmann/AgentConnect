import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBootstrap,
  BootstrapFailure,
  type BootstrapStep,
} from "../src/bootstrap-runner.js";
const steps: BootstrapStep[] = ["migration", "storage", "preflight", "server"];
test("deployment bootstrap starts the server only after migration, storage and preflight", async () => {
  const seen: string[] = [];
  await runBootstrap(
    Object.fromEntries(
      steps.map((step) => [
        step,
        async () => {
          seen.push(step);
        },
      ]),
    ) as Record<BootstrapStep, () => Promise<void>>,
  );
  assert.deepEqual(seen, steps);
});
for (const failed of steps)
  test(`bootstrap ${failed} failure prevents every later stage and retains safe stage identity`, async () => {
    const seen: string[] = [],
      secret = new Error("private provider connection details");
    await assert.rejects(
      () =>
        runBootstrap(
          Object.fromEntries(
            steps.map((step) => [
              step,
              async () => {
                seen.push(step);
                if (step === failed) throw secret;
              },
            ]),
          ) as Record<BootstrapStep, () => Promise<void>>,
        ),
      (error: unknown) => {
        assert(error instanceof BootstrapFailure);
        assert.equal(error.step, failed);
        assert.equal(error.cause, secret);
        assert(!error.message.includes(secret.message));
        return true;
      },
    );
    assert.deepEqual(seen, steps.slice(0, steps.indexOf(failed) + 1));
  });
