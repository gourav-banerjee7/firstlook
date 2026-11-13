/** Every setting comes from the environment, with defaults that work inside docker compose. */
const env = process.env;
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export type ProviderName = "playbook" | "gemini" | "ollama";

export const config = {
  port: num(env.PORT, 8080),
  webhookToken: env.WEBHOOK_TOKEN ?? "dev-webhook-token",
  adminToken: env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl: env.DATABASE_URL ?? "postgres://firstlook:firstlook@localhost:5432/firstlook",
  corsOrigin: env.CORS_ORIGIN ?? "*",

  sources: {
    prometheus: env.PROMETHEUS_URL ?? "http://localhost:9095",
    loki: env.LOKI_URL ?? "http://localhost:3100",
    tempo: env.TEMPO_URL ?? "http://localhost:3200",
    /** The deploy log. In the demo it's demo-api's /deploys; in real life, your CD system. */
    deploys: env.DEPLOYS_URL ?? "http://localhost:8081/deploys",
  },
  /** Grafana as a human opens it; used only to build evidence links. */
  grafanaUrl: env.GRAFANA_PUBLIC_URL ?? "http://localhost:3000",

  provider: (env.LLM_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "playbook")) as ProviderName,
  gemini: { apiKey: env.GEMINI_API_KEY ?? "", model: env.GEMINI_MODEL || "gemini-3.5-flash" },
  ollama: { url: env.OLLAMA_URL ?? "http://localhost:11434", model: env.OLLAMA_MODEL ?? "qwen2.5:7b" },

  budgets: {
    maxSteps: num(env.MAX_STEPS, 8),
    maxWallMs: num(env.MAX_WALL_MS, 120_000),
    maxTokens: num(env.MAX_TOKENS, 60_000),
  },

  langfuse: {
    host: env.LANGFUSE_HOST ?? "",
    publicKey: env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: env.LANGFUSE_SECRET_KEY ?? "",
  },
};

export type Config = typeof config;
