import { Readable } from "node:stream";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

export interface HttpProxyConfig {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export function readHttpProxyConfig(env: NodeJS.ProcessEnv = process.env): HttpProxyConfig {
  const allProxy = envValue(env, "all_proxy", "ALL_PROXY");
  const httpProxy = envValue(env, "http_proxy", "HTTP_PROXY") ?? allProxy;
  const httpsProxy = envValue(env, "https_proxy", "HTTPS_PROXY") ?? allProxy;
  const noProxy = envValue(env, "no_proxy", "NO_PROXY");
  return stripUndefined({
    enabled: Boolean(httpProxy || httpsProxy),
    httpProxy,
    httpsProxy,
    noProxy
  }) as HttpProxyConfig;
}

export function setupHttpProxyFromEnv(env: NodeJS.ProcessEnv = process.env): HttpProxyConfig {
  const config = readHttpProxyConfig(env);
  if (!config.enabled) return config;

  const options: ConstructorParameters<typeof EnvHttpProxyAgent>[0] = {};
  if (config.httpProxy) options.httpProxy = config.httpProxy;
  if (config.httpsProxy) options.httpsProxy = config.httpsProxy;
  if (config.noProxy) options.noProxy = config.noProxy;
  setGlobalDispatcher(new EnvHttpProxyAgent(options));
  return config;
}

export const proxyAwareFetch: typeof fetch = (input, init) => {
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    normalizeFetchInit(init) as Parameters<typeof undiciFetch>[1]
  ) as unknown as ReturnType<typeof fetch>;
};

export function proxyConfigLabel(config: HttpProxyConfig): string {
  if (!config.enabled) return "disabled";
  const parts: string[] = [];
  if (config.httpProxy) parts.push(`http=${maskProxyUrl(config.httpProxy)}`);
  if (config.httpsProxy) parts.push(`https=${maskProxyUrl(config.httpsProxy)}`);
  if (config.noProxy) parts.push(`no_proxy=${config.noProxy}`);
  return parts.join(" ");
}

function envValue(env: NodeJS.ProcessEnv, lower: string, upper: string): string | undefined {
  const value = env[lower] ?? env[upper];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "***" : "";
      url.password = url.password ? "***" : "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function normalizeFetchInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return init;

  let nextInit = normalizeAbortSignal(init);
  if (isNodeReadableBody(nextInit.body)) {
    nextInit = { ...nextInit, duplex: "half" } as RequestInit;
  }
  return nextInit;
}

function normalizeAbortSignal(init: RequestInit): RequestInit {
  const signal = (init as { signal?: unknown }).signal;
  if (!signal || signal instanceof AbortSignal) return init;

  const controller = new AbortController();
  if (isAbortSignalLike(signal)) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
  }
  return {
    ...init,
    signal: controller.signal
  };
}

interface AbortSignalLike {
  aborted: boolean;
  reason?: unknown;
  addEventListener(event: "abort", listener: () => void, options?: { once?: boolean }): void;
}

function isAbortSignalLike(signal: unknown): signal is AbortSignalLike {
  return (
    typeof signal === "object" &&
    signal !== null &&
    "aborted" in signal &&
    "addEventListener" in signal
  );
}

function isNodeReadableBody(body: unknown): body is Readable {
  return body instanceof Readable;
}
