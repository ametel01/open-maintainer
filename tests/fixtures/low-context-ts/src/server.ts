import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true }));
  app.get("/version", async () => ({ version: "0.1.0" }));
  return app;
}
