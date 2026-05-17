import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  hookMain,
  installAllHooks,
  installCodexHook,
  installHook,
  isHookInstalled,
  parseTmuxWindowInfo,
  processHookEvent,
  resolveHookCommand,
  UUID_RE
} from "../src/agent-connect/hook.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-connect-hook-test-"));
}

const validPayload = {
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  cwd: "/tmp/project",
  hook_event_name: "SessionStart"
};

describe("hook helpers", () => {
  it("validates UUID shape", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
  });

  it("detects installed hooks", () => {
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/usr/bin/agc hook", timeout: 5 }] }]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "'/Users/django/Library/pnpm/ccbot' hook", timeout: 5 }] }]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/ccbot-ts hook", timeout: 5 }] }]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/agc hook", timeout: 5 }] }]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/app/dist-ts/ts/ccbot/main.js' hook", timeout: 5 }] }]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "cd '/repo/apps/bot' && pnpm exec tsx src/agent-connect/main.ts hook",
                  timeout: 5
                }
              ]
            }
          ]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "cd '/repo/packages/cli' && pnpm exec tsx src/index.ts hook",
                  timeout: 5
                }
              ]
            }
          ]
        }
      })
    ).toBe(true);
    expect(
      isHookInstalled({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/repo/tools/main.ts hook", timeout: 5 }] }]
        }
      })
    ).toBe(false);
    expect(isHookInstalled({})).toBe(false);
  });

  it("parses tmux output while preserving colons in window names", () => {
    expect(parseTmuxWindowInfo("agent-connect:@3:proj:api")).toEqual({
      tmuxSessionName: "agent-connect",
      windowId: "@3",
      windowName: "proj:api"
    });
    expect(parseTmuxWindowInfo("bad")).toBeNull();
  });
});

describe("installHook", () => {
  it("installs the hook into settings.json", async () => {
    const dir = tmpDir();
    try {
      const settingsFile = join(dir, "settings.json");
      await expect(installHook({ settingsFile, hookCommand: "/bin/agc hook" })).resolves.toMatchObject({
        code: 0
      });

      const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(settings.hooks.SessionStart[0]?.hooks[0]).toMatchObject({
        type: "command",
        command: "/bin/agc hook",
        timeout: 5
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("synchronizes existing hooks without duplicates", async () => {
    const dir = tmpDir();
    try {
      const settingsFile = join(dir, "settings.json");
      writeFileSync(
        settingsFile,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ command: "agc hook" }] },
              { hooks: [{ command: "/old/path/ccbot hook" }] },
              { hooks: [{ command: "/old/path/ccbot-ts hook" }] }
            ]
          }
        }),
        "utf8"
      );

      await expect(installHook({ settingsFile, hookCommand: "/bin/agc hook" })).resolves.toMatchObject({
        code: 0
      });
      const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0]?.hooks).toEqual([
        {
          type: "command",
          command: "/bin/agc hook",
          timeout: 5
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not replace unrelated main.ts hooks", async () => {
    const dir = tmpDir();
    try {
      const settingsFile = join(dir, "settings.json");
      writeFileSync(
        settingsFile,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "/repo/tools/main.ts hook", timeout: 10 }] }
            ]
          }
        }),
        "utf8"
      );

      await expect(installHook({ settingsFile, hookCommand: "/bin/agc hook" })).resolves.toMatchObject({
        code: 0
      });
      const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart[0]?.hooks).toEqual([
        {
          type: "command",
          command: "/repo/tools/main.ts hook",
          timeout: 10
        }
      ]);
      expect(settings.hooks.SessionStart[1]?.hooks).toEqual([
        {
          type: "command",
          command: "/bin/agc hook",
          timeout: 5
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps synchronized hooks unchanged", async () => {
    const dir = tmpDir();
    try {
      const settingsFile = join(dir, "settings.json");
      writeFileSync(
        settingsFile,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "/bin/agc hook", timeout: 5 }] }]
          }
        }),
        "utf8"
      );

      await expect(installHook({ settingsFile, hookCommand: "/bin/agc hook" })).resolves.toMatchObject({
        code: 0,
        message: expect.stringContaining("already synchronized")
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs the hook into Codex hooks.json and enables the feature flag", async () => {
    const dir = tmpDir();
    try {
      const hooksFile = join(dir, "hooks.json");
      const configFile = join(dir, "config.toml");
      writeFileSync(configFile, 'model = "gpt-5.5"\n\n[features]\nshell_snapshot = true\n', "utf8");

      await expect(
        installCodexHook({ hooksFile, configFile, hookCommand: "/bin/agc hook" })
      ).resolves.toMatchObject({
        code: 0
      });

      const hooks = JSON.parse(readFileSync(hooksFile, "utf8")) as {
        hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(hooks.hooks.SessionStart[0]).toMatchObject({
        matcher: "startup|resume|clear",
        hooks: [
          {
            type: "command",
            command: "/bin/agc hook",
            timeout: 5
          }
        ]
      });
      expect(readFileSync(configFile, "utf8")).toContain("hooks = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates existing Codex agc hooks with the required matcher", async () => {
    const dir = tmpDir();
    try {
      const hooksFile = join(dir, "hooks.json");
      const configFile = join(dir, "config.toml");
      writeFileSync(configFile, "[features]\ncodex_hooks = true\n", "utf8");
      writeFileSync(
        hooksFile,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [{ command: "/old/path/agc hook" }]
              }
            ]
          }
        }),
        "utf8"
      );

      await expect(
        installCodexHook({ hooksFile, configFile, hookCommand: "/bin/agc hook" })
      ).resolves.toMatchObject({
        code: 0
      });

      const hooks = JSON.parse(readFileSync(hooksFile, "utf8")) as {
        hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(hooks.hooks.SessionStart).toEqual([
        {
          matcher: "startup|resume|clear",
          hooks: [
            {
              type: "command",
              command: "/bin/agc hook",
              timeout: 5
            }
          ]
        }
      ]);
      expect(readFileSync(configFile, "utf8")).not.toContain("codex_hooks");
      expect(readFileSync(configFile, "utf8")).toContain("hooks = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs Claude and Codex hooks together", async () => {
    const dir = tmpDir();
    try {
      const settingsFile = join(dir, "claude", "settings.json");
      const codexHooksFile = join(dir, "codex", "hooks.json");
      const codexConfigFile = join(dir, "codex", "config.toml");

      await expect(
        installAllHooks({
          settingsFile,
          codexHooksFile,
          codexConfigFile,
          hookCommand: "/bin/agc hook"
        })
      ).resolves.toMatchObject({
        code: 0
      });

      expect(isHookInstalled(JSON.parse(readFileSync(settingsFile, "utf8")))).toBe(true);
      const codexHooks = JSON.parse(readFileSync(codexHooksFile, "utf8")) as {
        hooks: { SessionStart: Array<{ matcher?: string }> };
      };
      expect(codexHooks.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear");
      expect(readFileSync(codexConfigFile, "utf8")).toContain("hooks = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveHookCommand", () => {
  it("uses the current agc binary entrypoint directly", async () => {
    await expect(
      resolveHookCommand({
        env: {},
        entrypoint: "/usr/local/bin/agc"
      })
    ).resolves.toBe("agc hook");
  });

  it("uses a dev-safe command for the TypeScript entrypoint", async () => {
    await expect(
      resolveHookCommand({
        env: {},
        entrypoint: "/repo/apps/bot/src/agent-connect/main.ts"
      })
    ).resolves.toBe("cd '/repo/apps/bot' && pnpm exec tsx src/agent-connect/main.ts hook");
  });

  it("uses node for the compiled entrypoint", async () => {
    await expect(
      resolveHookCommand({
        env: {},
        entrypoint: "/repo/apps/bot/dist/src/agent-connect/main.js"
      })
    ).resolves.toBe(`'${process.execPath}' '/repo/apps/bot/dist/src/agent-connect/main.js' hook`);
  });

  it("uses the package binary name for compiled entrypoints when agc is on PATH", async () => {
    const dir = tmpDir();
    try {
      const bin = join(dir, "agc");
      writeFileSync(bin, "#!/bin/sh\n", "utf8");
      chmodSync(bin, 0o755);

      await expect(
        resolveHookCommand({
          env: { PATH: dir },
          entrypoint: "/repo/packages/cli/dist/src/index.js"
        })
      ).resolves.toBe("agc hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a dev-safe command for the CLI TypeScript entrypoint", async () => {
    await expect(
      resolveHookCommand({
        env: {},
        entrypoint: "/repo/packages/cli/src/index.ts"
      })
    ).resolves.toBe("cd '/repo/packages/cli' && pnpm exec tsx src/index.ts hook");
  });

  it("uses the package binary name for TypeScript entrypoints when agc is on PATH", async () => {
    const dir = tmpDir();
    try {
      const bin = join(dir, "agc");
      writeFileSync(bin, "#!/bin/sh\n", "utf8");
      chmodSync(bin, 0o755);

      await expect(
        resolveHookCommand({
          env: { PATH: dir },
          entrypoint: "/repo/packages/cli/src/index.ts"
        })
      ).resolves.toBe("agc hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses node for the compiled CLI entrypoint", async () => {
    await expect(
      resolveHookCommand({
        env: {},
        entrypoint: "/repo/packages/cli/dist/src/index.js"
      })
    ).resolves.toBe(`'${process.execPath}' '/repo/packages/cli/dist/src/index.js' hook`);
  });
});

describe("processHookEvent", () => {
  it("ignores invalid payloads", async () => {
    const dir = tmpDir();
    try {
      await expect(
        processHookEvent(
          { ...validPayload, session_id: "bad" },
          { configDir: dir, env: { TMUX_PANE: "%1" } }
        )
      ).resolves.toBe(false);
      await expect(
        processHookEvent(
          { ...validPayload, cwd: "relative" },
          { configDir: dir, env: { TMUX_PANE: "%1" } }
        )
      ).resolves.toBe(false);
      expect(existsSync(join(dir, "session_map.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes session_map and removes old window-name keys", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, "session_map.json"),
        JSON.stringify({
          "agent-connect:project": { session_id: "old", cwd: "/old", window_name: "project" }
        }),
        "utf8"
      );

      await expect(
        processHookEvent(validPayload, {
          configDir: dir,
          env: { TMUX_PANE: "%1" },
          displayMessage: async () => "agent-connect:@9:project"
        })
      ).resolves.toBe(true);

      const sessionMap = JSON.parse(readFileSync(join(dir, "session_map.json"), "utf8"));
      expect(sessionMap).toEqual({
        "agent-connect:@9": {
          session_id: validPayload.session_id,
          cwd: "/tmp/project",
          window_name: "project"
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hookMain", () => {
  it("processes stdin JSON without requiring bot config", async () => {
    const dir = tmpDir();
    try {
      const input = Readable.from([JSON.stringify(validPayload)]);
      const output: string[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          output.push(String(chunk));
          callback();
        }
      });

      const code = await hookMain(["hook"], input, sink, sink);
      expect(code).toBe(0);
      expect(output).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
