/**
 * Environment variable configuration for LMCS Code.
 */

export interface EnvConfig {
  /** Base data directory for LMCS Code state */
  readonly home: string | undefined;
  /** Server port */
  readonly port: string | undefined;
  /** Disable auto-update */
  readonly disableAutoUpdate: string | undefined;
  /** Development auth token for testing */
  readonly devAuthToken: string | undefined;
}

/**
 * Get all LMCS Code environment configuration.
 */
export function getEnvConfig(): EnvConfig {
  return {
    home: process.env.LMCS_HOME,
    port: process.env.LMCS_PORT,
    disableAutoUpdate: process.env.LMCS_DISABLE_AUTO_UPDATE,
    devAuthToken: process.env.LMCS_DEV_AUTH_TOKEN,
  };
}

/**
 * Environment variable names.
 */
export const ENV_VARS = {
  HOME: "LMCS_HOME",
  PORT: "LMCS_PORT",
  DISABLE_AUTO_UPDATE: "LMCS_DISABLE_AUTO_UPDATE",
  DEV_AUTH_TOKEN: "LMCS_DEV_AUTH_TOKEN",
} as const;
