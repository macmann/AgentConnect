// The browser scenarios share the real API's IP rate limit. Pace integration
// requests instead of changing or bypassing the application's limit.
export async function paceApiBudget(testInfo, minimumRemaining = 180) {
  const response = await fetch("http://localhost:4000/auth/me", {
    signal: AbortSignal.timeout(5000),
  });
  const remaining = Number(
    response.headers.get("x-ratelimit-remaining") ?? 300,
  );
  if (response.status !== 429 && remaining >= minimumRemaining) return;
  const reset = Number(
    response.headers.get("retry-after") ??
      response.headers.get("x-ratelimit-reset") ??
      1,
  );
  const delay = Math.min(59000, Math.max(1000, reset * 1000 + 500));
  testInfo.setTimeout(testInfo.timeout + delay);
  console.log(
    "Pacing workspace browser scenario for the API rate-limit window",
  );
  await new Promise((resolve) => setTimeout(resolve, delay));
}
