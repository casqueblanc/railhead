/**
 * The URL of `suffix` under an HTTPS Git remote, or `null` when `remote` does not parse or carries
 * credentials, a query or a fragment. Trailing slashes on the remote are dropped before the join.
 */
export function gitServiceUrl(remote: string, suffix: string): URL | null {
  let base: URL;
  try {
    base = new URL(remote);
  } catch {
    return null;
  }
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    return null;
  }
  return new URL(`${base.href.replace(/\/+$/, "")}/${suffix}`);
}
