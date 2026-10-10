import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  checksum,
  openRecoveryBundle,
  sealRecoveryBundle,
  verifyRecoveryObject,
} from "../src/recovery-bundle.js";

test("recovery bundle authenticates ciphertext and requires its separate key", () => {
  const key = randomBytes(32);
  const bytes = Buffer.from("database dump and object fixture");
  const archive = sealRecoveryBundle(bytes, key);
  assert.deepEqual(openRecoveryBundle(archive, key), bytes);
  assert.equal(archive.includes(bytes), false);
  assert.notDeepEqual(sealRecoveryBundle(bytes, key), archive);
  assert.throws(() => openRecoveryBundle(archive, randomBytes(32)));
  const corrupt = Buffer.from(archive);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  assert.throws(() => openRecoveryBundle(corrupt, key));
  assert.throws(() => openRecoveryBundle(archive.subarray(0, 20), key));
  assert.throws(() => sealRecoveryBundle(bytes, Buffer.alloc(16)));
});
test("object verification rejects missing or changed bytes", () => {
  const bytes = Buffer.from("tenant document");
  verifyRecoveryObject(bytes, checksum(bytes));
  assert.throws(() => verifyRecoveryObject(undefined, checksum(bytes)));
  assert.throws(() =>
    verifyRecoveryObject(Buffer.from("changed"), checksum(bytes)),
  );
});
