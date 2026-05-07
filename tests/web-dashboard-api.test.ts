import { describe, expect, it } from "vitest";
import {
  createDashboardApiClient,
  dashboardActionError,
} from "../apps/web/app/dashboard-api";

describe("dashboard API client", () => {
  it("centralizes dashboard API reads with no-store JSON headers", async () => {
    const requests: Array<{ input: string | URL; init?: RequestInit }> = [];
    const client = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch(input, init) {
        requests.push({ input, init });
        return Response.json({ status: "ok" });
      },
    });

    await expect(client.fetchJson("/health")).resolves.toEqual({
      status: "ok",
    });
    expect(requests).toEqual([
      {
        input: "http://api.test/health",
        init: {
          cache: "no-store",
          headers: { "content-type": "application/json" },
        },
      },
    ]);
  });

  it("maps API action failures to redirect-safe action error codes", async () => {
    const client = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch(input, init) {
        expect(input).toBe("http://api.test/repos/repo_1/analyze");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ force: true }));
        return Response.json(
          { error: "No repo profile available." },
          {
            status: 409,
          },
        );
      },
    });

    await expect(
      client.postJson("/repos/repo_1/analyze", { force: true }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      actionError: "409:No repo profile available.",
    });
  });

  it("returns structured GET failures when pages need permission states", async () => {
    const client = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch() {
        return Response.json(
          { error: "Pull request data requires GitHub App credentials." },
          { status: 409 },
        );
      },
    });

    await expect(client.getJson("/repos/repo_1/pulls")).resolves.toEqual({
      ok: false,
      status: 409,
      actionError: "409:Pull request data requires GitHub App credentials.",
    });
  });

  it("returns unreachable when the owned API cannot be reached", async () => {
    const client = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch() {
        throw new Error("connection refused");
      },
    });

    await expect(client.fetchJson("/health")).resolves.toBeNull();
    await expect(client.postJson("/repos/repo_1/analyze", {})).resolves.toEqual(
      {
        ok: false,
        status: null,
        actionError: "unreachable",
      },
    );
  });

  it("falls back to status-only action errors for non-json failures", async () => {
    const response = new Response("nope", { status: 502 });

    await expect(dashboardActionError(response)).resolves.toBe("502");
  });
});
