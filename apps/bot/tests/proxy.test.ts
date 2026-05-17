import { describe, expect, it } from "vitest";
import { proxyAwareFetch, proxyConfigLabel, readHttpProxyConfig } from "../src/agent-connect/proxy.js";

describe("HTTP proxy config", () => {
  it("is disabled when proxy env vars are missing", () => {
    expect(readHttpProxyConfig({})).toEqual({ enabled: false });
  });

  it("uses protocol-specific proxy variables", () => {
    expect(
      readHttpProxyConfig({
        HTTP_PROXY: "http://127.0.0.1:7890",
        HTTPS_PROXY: "http://127.0.0.1:7891",
        NO_PROXY: "localhost"
      })
    ).toEqual({
      enabled: true,
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7891",
      noProxy: "localhost"
    });
  });

  it("uses ALL_PROXY as a fallback", () => {
    expect(readHttpProxyConfig({ ALL_PROXY: "http://127.0.0.1:7890" })).toEqual({
      enabled: true,
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890"
    });
  });

  it("masks credentials in log labels", () => {
    expect(
      proxyConfigLabel({
        enabled: true,
        httpsProxy: "http://user:pass@127.0.0.1:7890"
      })
    ).toBe("https=http://***:***@127.0.0.1:7890/");
  });

  it("exposes a fetch implementation for grammY", () => {
    expect(proxyAwareFetch).toEqual(expect.any(Function));
  });
});
