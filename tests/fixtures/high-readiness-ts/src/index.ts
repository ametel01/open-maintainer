export function getDatabaseUrl() {
  return process.env["DATABASE_URL"] ?? "sqlite://fixture";
}
