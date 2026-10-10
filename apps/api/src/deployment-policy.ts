type DeploymentConfig = {
  NODE_ENV: string;
  S3_ACCESS_KEY: string;
  MASTER_KEY: string;
};
export function deploymentEnvironmentCode(
  config: DeploymentConfig,
  development: boolean,
) {
  return !development && config.NODE_ENV !== "production"
    ? "PRODUCTION_ENV_REQUIRED"
    : null;
}
export function deploymentPolicyCode(
  config: DeploymentConfig,
  role: { rolsuper: boolean; rolbypassrls: boolean } | undefined,
  development: boolean,
) {
  if (development) return null;
  if (!role || role.rolsuper || role.rolbypassrls)
    return "APPLICATION_ROLE_TOO_PRIVILEGED";
  if (
    config.S3_ACCESS_KEY === "minioadmin" ||
    /^(.)\1{63}$/.test(config.MASTER_KEY)
  )
    return "DEVELOPMENT_CREDENTIALS_REJECTED";
  return null;
}
