import type { NextRequest } from "next/server";
import { dashboardApi } from "../dashboard-api";
import { providerPreset } from "../dashboard-contracts";
import { redirectToDashboard } from "../redirect";

type ProviderListResponse = {
  providers?: Array<{ id?: unknown; kind?: unknown; model?: unknown }>;
};

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const repoId = String(form.get("repoId") ?? "").trim();
  const providerId = String(form.get("providerId") ?? "").trim();
  const providerType = String(form.get("providerType") ?? "");
  const preset = providerPreset(providerType);
  const requestedModel = String(form.get("model") ?? "").trim();
  const repoContentConsent = form.get("repoContentConsent") === "on";
  const targetModel = requestedModel || preset?.model;

  const params: Record<string, string> = {};
  if (repoId) {
    params["repo"] = repoId;
  }
  if (providerId) {
    return redirectToDashboard(request, { ...params, providerId });
  }

  if (!preset) {
    return redirectToDashboard(request, {
      ...params,
      providerError: "invalid-provider",
    });
  }
  if (!repoContentConsent) {
    return redirectToDashboard(request, {
      ...params,
      providerError: "missing-consent",
    });
  }

  try {
    const existing =
      await dashboardApi.fetchJson<ProviderListResponse>("/model-providers");
    if (existing) {
      const matchingProvider = existing.providers?.find(
        (provider) =>
          provider.kind === preset.kind &&
          typeof provider.id === "string" &&
          provider.model === targetModel,
      );
      if (typeof matchingProvider?.id === "string") {
        return redirectToDashboard(request, {
          ...params,
          providerId: matchingProvider.id,
        });
      }
    }

    const response = await dashboardApi.postJson<{
      provider?: { id?: unknown };
    }>("/model-providers", {
      ...preset,
      baseUrl: "http://localhost",
      model: targetModel,
      apiKey: "local-cli",
      repoContentConsent,
    });
    if (!response.ok) {
      return redirectToDashboard(request, {
        ...params,
        providerError: response.actionError,
      });
    }
    const payload = response.payload;
    if (typeof payload.provider?.id === "string") {
      params["providerId"] = payload.provider.id;
    }
  } catch {
    return redirectToDashboard(request, {
      ...params,
      providerError: "unreachable",
    });
  }

  return redirectToDashboard(request, params);
}
