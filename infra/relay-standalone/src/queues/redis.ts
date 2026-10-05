import Redis from "ioredis";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface RedisConfig {
  url: string;
  host: string;
  port: number;
}

export class RedisClient extends Context.Tag("RedisClient")<RedisClient, Redis>() {}

export const createRedisLayer = (config: RedisConfig) => {
  return Layer.effect(
    RedisClient,
    Effect.tryPromise({
      try: async () => {
        const client = new Redis(config.url);
        await client.ping();
        console.log("Redis connected successfully");
        return client;
      },
      catch: (error: any) => new Error(`Redis connection failed: ${error}`),
    }),
  );
};
