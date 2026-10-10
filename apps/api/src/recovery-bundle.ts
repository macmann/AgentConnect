import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// A bounded drill archive. This is deliberately not a streaming production backup.
const limit = 64 * 1024 * 1024;
const aad = Buffer.from("agentconnect-recovery-drill:v1");
export function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function sealRecoveryBundle(bytes: Buffer, key: Buffer) {
  if (key.length !== 32 || bytes.length > limit)
    throw new Error("INVALID_RECOVERY_BUNDLE");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([
    Buffer.from("ACR1"),
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]);
}
export function openRecoveryBundle(bytes: Buffer, key: Buffer) {
  if (
    key.length !== 32 ||
    bytes.length < 32 ||
    bytes.length > limit + 32 ||
    bytes.subarray(0, 4).toString() !== "ACR1"
  )
    throw new Error("INVALID_RECOVERY_BUNDLE");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4, 16));
  cipher.setAAD(aad);
  cipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]);
}
export function verifyRecoveryObject(
  bytes: Uint8Array | undefined,
  expectedHash: string,
) {
  if (!bytes || checksum(bytes) !== expectedHash)
    throw new Error("RECOVERY_OBJECT_INTEGRITY_FAILED");
}
