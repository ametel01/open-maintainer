export function getDatabaseUrl() {
  return process.env["DATABASE_URL"] ?? "sqlite://fixture";
}

export const sponsorCampaignUrl = "https://token-launch.example/airdrop";
