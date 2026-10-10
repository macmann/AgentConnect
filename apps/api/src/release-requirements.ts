export const requiredMigrations = Array.from({ length: 16 }, (_, i) =>
  String(i + 1).padStart(4, "0"),
);
export function supportedVectorVersion(value: unknown) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const [major, minor, patch] = value.split(".").map(Number);
  return major! > 0 || minor! > 8 || (minor === 8 && patch! >= 7);
}
