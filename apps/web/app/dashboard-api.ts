export type DashboardApiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DashboardApiActionResult<T> =
  | { ok: true; status: number; payload: T }
  | { ok: false; status: number | null; actionError: string };

export type DashboardApiClient = {
  url(path: string): string;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T | null>;
  postJson<T>(
    path: string,
    body: unknown,
  ): Promise<DashboardApiActionResult<T>>;
};

export function dashboardApiBaseUrl(): string {
  return (
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:4000"
  );
}

export function createDashboardApiClient(
  input: {
    baseUrl?: string;
    fetch?: DashboardApiFetch;
  } = {},
): DashboardApiClient {
  const baseUrl = input.baseUrl ?? dashboardApiBaseUrl();
  const apiFetch = input.fetch ?? fetch;

  function url(path: string): string {
    return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async function fetchJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | null> {
    try {
      const response = await apiFetch(url(path), {
        ...init,
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async function postJson<T>(
    path: string,
    body: unknown,
  ): Promise<DashboardApiActionResult<T>> {
    try {
      const response = await apiFetch(url(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          actionError: await dashboardActionError(response),
        };
      }
      return {
        ok: true,
        status: response.status,
        payload: (await response.json()) as T,
      };
    } catch {
      return { ok: false, status: null, actionError: "unreachable" };
    }
  }

  return { url, fetchJson, postJson };
}

export const dashboardApi = createDashboardApiClient();

export async function dashboardActionError(
  response: Response,
): Promise<string> {
  const status = String(response.status);
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  return typeof payload.error === "string"
    ? `${status}:${payload.error}`
    : status;
}
