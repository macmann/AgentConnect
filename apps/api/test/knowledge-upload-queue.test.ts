import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  KnowledgeUploadQueue,
  type UploadTransport,
} from "../../web/components/knowledge-upload-queue.js";
const base = { id: "kb-one", name: "First knowledge" };
const files = (n: number) =>
  Array.from({ length: n }, (_, i) => new File([`Document ${i}`], `${i}.txt`));
async function settle() {
  for (let i = 0; i < 5; i++) await setImmediate();
}
function controlled() {
  const calls: {
    id: string;
    base: string;
    resolve: (v: { id: string }) => void;
    reject: (e: Error) => void;
  }[] = [];
  const transport: UploadTransport = (row, _file, progress, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ id: row.id, base: row.knowledgeBaseId, resolve, reject });
      progress(50);
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  return { calls, queue: new KnowledgeUploadQueue(transport) };
}
test("100 uploads drain with bounded concurrency and distinct durable keys", async () => {
  let active = 0,
    peak = 0,
    completed = 0;
  const ids = new Set<string>();
  const queue = new KnowledgeUploadQueue(async (row) => {
    active++;
    peak = Math.max(peak, active);
    ids.add(row.id);
    await setImmediate();
    active--;
    completed++;
    return { id: row.id };
  });
  queue.add(files(100), base);
  while (queue.hasPending()) await setImmediate();
  assert.equal(peak, 2);
  assert.equal(completed, 100);
  assert.equal(ids.size, 100);
  assert.ok(
    queue
      .getSnapshot()
      .rows.every((r) => r.status === "uploaded" && r.progress === 100),
  );
  assert.throws(() => queue.add(files(1), base), /100 files/);
  queue.clearFinished();
  assert.equal(queue.getSnapshot().rows.length, 0);
  queue.dispose();
});
test("pause drains active only; concurrency and destination remain explicit", async () => {
  const { calls, queue } = controlled();
  queue.concurrency(1);
  queue.add(files(3), base);
  await settle();
  assert.equal(calls.length, 1);
  queue.pause(true);
  calls[0]!.resolve({ id: calls[0]!.id });
  await settle();
  assert.equal(calls.length, 1);
  queue.add(files(1), { id: "kb-two", name: "Second" });
  queue.concurrency(3);
  queue.pause(false);
  await settle();
  assert.deepEqual(
    calls.map((c) => c.base),
    ["kb-one", "kb-one", "kb-one", "kb-two"],
  );
  for (const c of calls.slice(1)) c.resolve({ id: c.id });
  await settle();
  assert.equal(queue.hasPending(), false);
  queue.dispose();
});
test("failed upload retries the same key; cancellation releases slots without stopping others", async () => {
  const { calls, queue } = controlled();
  queue.concurrency(1);
  queue.add(files(3), base);
  await settle();
  calls[0]!.reject(new Error("lost response"));
  await settle();
  const first = queue.getSnapshot().rows[0]!;
  assert.equal(first.status, "failed");
  queue.retry(first.id);
  queue.cancel(calls[1]!.id);
  await settle();
  assert.equal(queue.getSnapshot().rows[1]!.status, "cancelled");
  assert.equal(calls[2]!.id, first.id);
  calls[2]!.resolve({ id: first.id });
  await settle();
  calls[3]!.resolve({ id: calls[3]!.id });
  await settle();
  assert.equal(queue.getSnapshot().rows[0]!.status, "uploaded");
  queue.dispose();
});
test("invalid files fail independently and disposal stops pending requests", async () => {
  const { calls, queue } = controlled();
  queue.pause(true);
  queue.add(
    [
      new File([], "empty.txt"),
      new File(["bad"], "bad.exe"),
      new File([new Uint8Array(10_000_001)], "large.txt"),
      ...files(3),
    ],
    base,
  );
  assert.equal(queue.getSnapshot().rows.filter((r) => r.invalid).length, 3);
  queue.retry(queue.getSnapshot().rows[0]!.id);
  queue.pause(false);
  await settle();
  assert.equal(calls.length, 2);
  queue.dispose();
  await settle();
  assert.equal(calls.length, 2);
  assert.throws(() => queue.add(files(1), base), /closed/);
});
