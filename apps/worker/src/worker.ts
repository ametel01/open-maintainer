const apiBaseUrl = process.env["API_BASE_URL"] ?? "http://localhost:4000";

async function heartbeat() {
  try {
    await fetch(`${apiBaseUrl}/worker/heartbeat`, { method: "POST" });
    console.log("worker heartbeat recorded");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "worker heartbeat failed",
    );
  }
}

await heartbeat();
setInterval(() => {
  void heartbeat();
}, 15_000);

export {};
