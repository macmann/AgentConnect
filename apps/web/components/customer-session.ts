import { apiBase } from "./agent-client";
export type CustomerMemory = {
  token: string;
  active?: string;
  expiresAt: string;
};
export const memoryKey = (base: string) =>
  "agentconnect:customer:" + apiBase + base;
export function readMemory(base: string): CustomerMemory | null {
  try {
    const value = JSON.parse(localStorage.getItem(memoryKey(base)) ?? "null");
    return value &&
      typeof value.token === "string" &&
      Date.parse(value.expiresAt) > Date.now()
      ? value
      : null;
  } catch {
    return null;
  }
}
export function writeMemory(base: string, value: CustomerMemory | null) {
  try {
    if (value) localStorage.setItem(memoryKey(base), JSON.stringify(value));
    else localStorage.removeItem(memoryKey(base));
  } catch {
    /* Chat still works without browser storage. */
  }
}
export async function customerRequest<T>(
  base: string,
  memory: CustomerMemory,
  suffix: string,
  method = "GET",
): Promise<T> {
  const response = await fetch(apiBase + base + suffix, {
    method,
    credentials: "omit",
    headers: { authorization: "Bearer " + memory.token },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error ?? "Unable to load customer history");
  return data as T;
}
export async function openCustomerSession(base: string) {
  let memory = readMemory(base);
  const response = await fetch(apiBase + base + "/sessions", {
    method: "POST",
    credentials: "omit",
    headers: memory ? { authorization: "Bearer " + memory.token } : {},
  });
  if (response.status === 401 && memory) {
    writeMemory(base, null);
    return openCustomerSession(base);
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Unable to start customer session");
  memory = {
    ...memory,
    token: data.token ?? memory!.token,
    expiresAt: data.expiresAt,
  };
  writeMemory(base, memory);
  return memory;
}
