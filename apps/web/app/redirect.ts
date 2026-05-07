import { type NextRequest, NextResponse } from "next/server";

const MAX_DASHBOARD_PARAM_LENGTH = 500;

export function redirectToDashboard(
  request: NextRequest,
  params: Record<string, string>,
): NextResponse {
  return redirectToDashboardRoute(request, "/", params);
}

export function redirectToDashboardRoute(
  request: NextRequest,
  pathname: string,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(pathname, dashboardOrigin(request));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, safeDashboardParam(value));
  }
  return NextResponse.redirect(url, { status: 303 });
}

function safeDashboardParam(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_DASHBOARD_PARAM_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DASHBOARD_PARAM_LENGTH - 3)}...`;
}

function dashboardOrigin(request: NextRequest): string {
  const requestUrl = new URL(request.url);
  const host = browserReachableHost(
    request.headers.get("x-forwarded-host") ??
      request.headers.get("host") ??
      requestUrl.host,
  );
  const protocol =
    request.headers.get("x-forwarded-proto") ??
    requestUrl.protocol.slice(0, -1) ??
    "http";
  return `${protocol}://${host}`;
}

function browserReachableHost(host: string): string {
  if (host.startsWith("0.0.0.0")) {
    return `localhost${host.slice("0.0.0.0".length)}`;
  }
  if (host.startsWith("[::]")) {
    return `localhost${host.slice("[::]".length)}`;
  }
  return host;
}
