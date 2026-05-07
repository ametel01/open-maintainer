type DashboardRouteState = {
  providerId?: string | null;
  repoId?: string | null;
};

export function contextDashboardHref(state: DashboardRouteState): string {
  return dashboardHref("/", state);
}

export function pullRequestsDashboardHref(state: DashboardRouteState): string {
  return dashboardHref("/pull-requests", state);
}

function dashboardHref(pathname: string, state: DashboardRouteState): string {
  const params = new URLSearchParams();
  if (state.repoId) {
    params.set("repo", state.repoId);
  }
  if (state.providerId) {
    params.set("providerId", state.providerId);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
