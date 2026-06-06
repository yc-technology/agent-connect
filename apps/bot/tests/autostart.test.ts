import { describe, expect, it } from "vitest";

import { AUTOSTART_LABEL, plistPath, renderPlist } from "../src/agent-connect/autostart.js";

describe("autostart launchd plist", () => {
  const base = {
    nodePath: "/opt/homebrew/bin/node",
    cliEntry: "/Users/me/.npm/agc/index.js",
    home: "/Users/me"
  };

  it("renders ignition-only config: RunAtLoad on, KeepAlive off", () => {
    const xml = renderPlist({ ...base, env: {} });
    expect(xml).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    // RunAtLoad true, KeepAlive false — launchd ignites once, our supervisor keepalives.
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--daemon</string>");
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/Users/me/.npm/agc/index.js</string>");
  });

  it("includes Homebrew + node dir on PATH so tmux resolves under launchd", () => {
    const xml = renderPlist({ ...base, env: { PATH: "/custom/bin" } });
    const pathLine = xml.split("\n").find((line) => line.includes("/custom/bin")) ?? "";
    expect(pathLine).toContain("/opt/homebrew/bin");
    expect(pathLine).toContain("/usr/bin");
    expect(pathLine).toContain("/custom/bin");
    // node's own dir is prepended
    expect(pathLine).toContain("/opt/homebrew/bin/node".replace(/\/node$/, ""));
  });

  it("propagates AGENT_CONNECT_* knobs but not unrelated env", () => {
    const xml = renderPlist({
      ...base,
      env: { AGENT_CONNECT_HTTP_PORT: "17777", AGENT_CONNECT_DIR: "/tmp/agc", SECRET_TOKEN: "nope" }
    });
    expect(xml).toContain("<key>AGENT_CONNECT_HTTP_PORT</key>");
    expect(xml).toContain("<string>17777</string>");
    expect(xml).toContain("<key>AGENT_CONNECT_DIR</key>");
    expect(xml).not.toContain("SECRET_TOKEN");
  });

  it("plistPath lands in the user LaunchAgents dir", () => {
    expect(plistPath("/Users/me")).toBe(`/Users/me/Library/LaunchAgents/${AUTOSTART_LABEL}.plist`);
  });
});
