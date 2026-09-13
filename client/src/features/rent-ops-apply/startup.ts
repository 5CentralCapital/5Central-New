let optionsRequest: Promise<Response> | undefined;

/** Overlap the public home list with the form download. Secure resume links
 * retain their existing consume-before-request sequence. */
export function preloadApplicantOptions(location: Pick<Location, 'pathname' | 'search' | 'hash'>): void {
  if (optionsRequest || !/^\/apply(?:\/|$)/.test(location.pathname) || location.search || location.hash
    || (import.meta.env?.VITE_RENT_OPS_APPLY_DEMO === 'true' && import.meta.env?.VITE_RENT_OPS_LOCAL_SYNTHETIC_BUILD === 'true')) return;
  optionsRequest = fetch('/api/rent-ops/public/application-options', {
    credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  void optionsRequest.catch(() => undefined);
}

export function takeApplicantOptions(): Promise<Response> | undefined {
  const request = optionsRequest;
  optionsRequest = undefined;
  return request;
}
