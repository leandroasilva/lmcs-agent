export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  database: {
    url: string;
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
  };
  redis: {
    url: string;
    host: string;
    port: number;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  relayDomain: string;
  tunnelDomain: string;
  cloudflare?: {
    tunnelToken?: string;
    accountId?: string;
    apiToken?: string;
  };
  logLevel: string;
  corsOrigin: string;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid integer`);
  }
  return parsed;
}

export const config: Config = {
  nodeEnv: getEnv("NODE_ENV", "development"),
  port: getEnvInt("PORT", 3000),
  host: getEnv("HOST", "0.0.0.0"),

  database: {
    url: getEnv("DATABASE_URL", "mysql://lmcs_relay:password@localhost:3306/lmcs_relay"),
    host: getEnv("DATABASE_HOST", "localhost"),
    port: getEnvInt("DATABASE_PORT", 3306),
    user: getEnv("DATABASE_USER", "lmcs_relay"),
    password: getEnv("DATABASE_PASSWORD", "password"),
    name: getEnv("DATABASE_NAME", "lmcs_relay"),
  },

  redis: {
    url: getEnv("REDIS_URL", "redis://localhost:6379"),
    host: getEnv("REDIS_HOST", "localhost"),
    port: getEnvInt("REDIS_PORT", 6379),
  },

  jwt: {
    secret: getEnv("JWT_SECRET", "change-this-secret-in-production"),
    expiresIn: getEnv("JWT_EXPIRES_IN", "7d"),
  },

  relayDomain: getEnv("RELAY_DOMAIN", "agent.lmcs.tec.br"),
  tunnelDomain: getEnv("RELAY_TUNNEL_DOMAIN", "tunnels.lmcs.tec.br"),

  cloudflare: {
    tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  },

  logLevel: getEnv("LOG_LEVEL", "info"),
  corsOrigin: getEnv("CORS_ORIGIN", "*"),
};
