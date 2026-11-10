export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ConnectorError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function hintFor(status: number, service: string): string {
  if (status === 401) return `${service} rejected the credentials. Re-run \`codify connect\` to update the token.`;
  if (status === 403) return `${service} denied access. Check the token's scopes and your permissions on this resource.`;
  if (status === 404) return `${service} returned 404. Check the URL, key or repository name (private resources also return 404 without access).`;
  if (status === 429) return `${service} rate limit reached. Try again later.`;
  return `${service} returned HTTP ${status}.`;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  service: string;
  retries?: number;
  timeoutMs?: number;
}

/** GET JSON with timeout, 429/5xx retry (honouring Retry-After) and readable errors. */
export async function getJson<T>(fetchFn: FetchLike, url: string, opts: HttpOptions): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { accept: "application/json", "user-agent": "codify-buddy", ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new ConnectorError(`Could not reach ${opts.service} (${new URL(url).host}): ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw new ConnectorError(hintFor(res.status, opts.service), res.status);
  }
}

export function basicAuth(user: string, secret: string): string {
  return "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Trim trailing slashes from a base URL. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}
