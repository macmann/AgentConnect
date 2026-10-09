import {
  randomBytes,
  scrypt as cbScrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
const scrypt = promisify(cbScrypt);
export const token = () => randomBytes(32).toString("hex");
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function hashPassword(p: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(p, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function checkPassword(p: string, h: string) {
  const [salt, key] = h.split(":");
  if (!salt || !key) return false;
  const derived = (await scrypt(p, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
function seal(value: Buffer, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}
function open(e: ReturnType<typeof seal>, key: Buffer, aad: string) {
  const c = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "hex"));
  c.setAAD(Buffer.from(aad));
  c.setAuthTag(Buffer.from(e.tag, "hex"));
  return Buffer.concat([c.update(Buffer.from(e.data, "hex")), c.final()]);
}
export function encrypt(value: string, context: string) {
  const key = randomBytes(32);
  return {
    version: 1,
    key: seal(key, Buffer.from(config.MASTER_KEY, "hex"), context),
    value: seal(Buffer.from(value), key, context),
  };
}
export function decrypt(e: ReturnType<typeof encrypt>, context: string) {
  return open(
    e.value,
    open(e.key, Buffer.from(config.MASTER_KEY, "hex"), context),
    context,
  ).toString();
}
