import type { FastifyRequest, FastifyReply } from "fastify";
// Send invalidations only. Reconnect always refreshes authorized durable projections.
export async function supportStream(
  r: FastifyRequest,
  reply: FastifyReply,
  read: () => Promise<string>,
) {
  const initial = await read();
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders()))
    if (value !== undefined) reply.raw.setHeader(name, value);
  reply.raw.statusCode = 200;
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("x-accel-buffering", "no");
  reply.raw.flushHeaders();
  let stopped = false;
  const close = () => {
    stopped = true;
  };
  reply.raw.on("close", close);
  const write = (revision: string) =>
    reply.raw.write(
      "event: refresh\ndata: " + JSON.stringify({ revision }) + "\n\n",
    );
  let last = initial;
  write(initial);
  const end = Date.now() + 25000;
  try {
    while (!stopped && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (stopped) break;
      const revision = await read();
      if (revision !== last) {
        last = revision;
        if (!write(revision)) break;
      } else reply.raw.write(": heartbeat\n\n");
    }
  } catch {
    if (!stopped) reply.raw.write("event: unavailable\ndata: {}\n\n");
  } finally {
    reply.raw.off("close", close);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
