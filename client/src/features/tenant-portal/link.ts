export interface ActivationLink {
  token?: string;
  invalid: boolean;
}

/** Consume the one-time link before rendering or making any network request. */
export function consumeActivationLink(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): ActivationLink {
  if (!location.hash) return { invalid: false };
  const fragment = location.hash;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const params = new URLSearchParams(fragment.slice(1));
  const token = params.get("activate");
  if (!token || params.getAll("activate").length !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    return { invalid: true };
  }
  return { token, invalid: false };
}

/** Links stay on the current origin and use a fragment, never a query token. */
export function activationUrl(path: string, origin: string): string {
  const url = new URL(path, origin);
  const expected = new URL(origin);
  if (url.origin !== expected.origin || url.pathname !== "/tenant" || url.search) {
    throw new Error("The account link could not be verified. Create a new link.");
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get("activate");
  if (!token || params.getAll("activate").length !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("The account link could not be verified. Create a new link.");
  }
  return `${url.origin}/tenant#activate=${token}`;
}

export function centsFromAmount(value: string): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return undefined;
  const [dollars, cents = ""] = value.trim().split(".");
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}
