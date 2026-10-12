/** Only registered Quality Lab routes receive this diagnostic; never return raw SQL details. */
export function qualityFailure(route: string, error: unknown) {
  if (
    !/\/(datasets|evaluations|quality-models|quality-gates)(\/|$)/.test(route)
  )
    return null;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "UNKNOWN";
  return {
    code,
    guidance: ["42P01", "42703"].includes(code)
      ? "Quality Lab database schema is unavailable or incompatible. Run pnpm db:migrate, then restart the API and worker."
      : null,
  };
}
