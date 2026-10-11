export function validateManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.commit)
  )
    throw new Error("INVALID_RELEASE_MANIFEST");
  for (const service of ["api", "worker", "web"])
    if (
      typeof value.images?.[service] !== "string" ||
      !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(value.images[service])
    )
      throw new Error("IMMUTABLE_IMAGES_REQUIRED");
  if (typeof value.publicApiUrl !== "string")
    throw new Error("HTTPS_PUBLIC_API_REQUIRED");
  let url;
  try {
    url = new URL(value.publicApiUrl);
  } catch {
    throw new Error("HTTPS_PUBLIC_API_REQUIRED");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("HTTPS_PUBLIC_API_REQUIRED");
  return value;
}
