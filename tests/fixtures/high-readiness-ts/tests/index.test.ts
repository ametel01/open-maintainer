import { describe, expect, it } from "vitest";
import { getDatabaseUrl } from "../src";

describe("getDatabaseUrl", () => {
  it("returns a fallback database URL", () => {
    expect(getDatabaseUrl()).toBe(
      process.env["DATABASE_URL"] ?? "sqlite://fixture",
    );
  });
});
