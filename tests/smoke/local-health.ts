const apiBaseUrl =
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  process.env["API_BASE_URL"] ??
  "http://localhost:4000";

const response = await fetch(`${apiBaseUrl}/health`);
if (!response.ok) {
  throw new Error(`Health check failed with HTTP ${response.status}`);
}

const health = (await response.json()) as {
  api: string;
  database: string;
  redis: string;
  worker: string;
};

console.log(JSON.stringify(health, null, 2));

if (health.api !== "ok" || health.database !== "ok" || health.redis !== "ok") {
  throw new Error("API, Postgres, and Redis must be healthy.");
}
