import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://code.lmcs.tec.br",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
