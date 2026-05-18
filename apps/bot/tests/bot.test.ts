import { describe, expect, it, vi } from "vitest";
import {
  BOT_COMMANDS,
  BotStateStore,
  buildScreenshotKeyboard,
  escCommand,
  forwardCommandHandler,
  formatUsageReply,
  getThreadId,
  historyCommand,
  historyCallbackHandler,
  interactiveCallbackHandler,
  isUserAllowed,
  killCommand,
  pickerCallbackHandler,
  photoMessageHandler,
  screenshotCallbackHandler,
  screenshotCommand,
  startCommand,
  textMessageHandler,
  setupBotCommands,
  setupBotCommandsIfPossible,
  topicClosedHandler,
  topicEditedHandler,
  unsupportedContentHandler,
  unbindCommand,
  usageCommand
} from "../src/agent-connect/bot.js";
import { WindowState, type HistoryMessage } from "../src/agent-connect/session.js";

const config = {
  showUserMessages: true,
  showHiddenDirs: false,
  agentType: "claude" as const,
  isUserAllowed: (userId: number) => userId === 12345
};

const formattedOptions = expect.objectContaining({ entities: expect.any(Array) });

describe("bot helpers", () => {
  it("checks authorization", () => {
    expect(isUserAllowed(12345, config)).toBe(true);
    expect(isUserAllowed(99999, config)).toBe(false);
    expect(isUserAllowed(undefined, config)).toBe(false);
  });

  it("normalizes topic thread ids", () => {
    expect(getThreadId({ msg: { message_thread_id: 42 } as never })).toBe(42);
    expect(getThreadId({ msg: { message_thread_id: 1 } as never })).toBeNull();
    expect(getThreadId({ msg: {} as never })).toBeNull();
    expect(getThreadId({ msg: {} as never, chat: { type: "private" } as never })).toBe(0);
  });
});

describe("bot commands", () => {
  it("start replies to authorized users", async () => {
    const reply = vi.fn();
    await startCommand({ from: { id: 12345 } as never, reply: reply as never }, config);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code Monitor"),
      formattedOptions
    );
  });

  it("start rejects unauthorized users", async () => {
    const reply = vi.fn();
    await startCommand({ from: { id: 99999 } as never, reply: reply as never }, config);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"), formattedOptions);
  });

  it("history reports missing topic binding", async () => {
    const reply = vi.fn();
    await historyCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: reply as never
      },
      config,
      {
        resolveWindowForThread: () => null,
        getDisplayName: () => "",
        getRecentMessages: vi.fn(),
        updateUserWindowOffset: vi.fn()
      }
    );
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("No session bound"), formattedOptions);
  });

  it("history sends rendered session history", async () => {
    const reply = vi.fn();
    await historyCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: reply as never
      },
      config,
      {
        resolveWindowForThread: () => "@5",
        getDisplayName: () => "project",
        getRecentMessages: vi.fn(async (): Promise<[HistoryMessage[], number]> => [
          [
            {
              role: "assistant",
              text: "done",
              contentType: "text",
              timestamp: "2026-05-16T10:11:00.000Z"
            }
          ],
          1
        ]),
        updateUserWindowOffset: vi.fn()
      }
    );
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("project"), formattedOptions);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("done"), formattedOptions);
  });

  it("history callback edits the requested page", async () => {
    const editMessageText = vi.fn();
    const answerCallbackQuery = vi.fn();

    await historyCallbackHandler(
      {
        callbackQuery: { data: "hp:0:@5:0:0" } as never,
        editMessageText: editMessageText as never,
        answerCallbackQuery: answerCallbackQuery as never
      },
      config,
      {
        getDisplayName: () => "project",
        getRecentMessages: vi.fn(async (): Promise<[HistoryMessage[], number]> => [
          [{ role: "assistant", text: "older page", contentType: "text" }],
          1
        ])
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" }))
      }
    );

    expect(editMessageText).toHaveBeenCalledWith(expect.stringContaining("older page"), formattedOptions);
    expect(answerCallbackQuery).toHaveBeenCalledWith("Page updated");
  });
});

describe("bot session commands", () => {
  it("esc sends Escape to the bound window", async () => {
    const reply = vi.fn();
    const sendKeys = vi.fn(async () => true);

    await escCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: reply as never
      },
      config,
      {
        resolveWindowForThread: () => "@5",
        getDisplayName: () => "project"
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        sendKeys
      }
    );

    expect(sendKeys).toHaveBeenCalledWith("@5", "Escape", { enter: false, literal: false });
    expect(reply).toHaveBeenCalledWith("⎋ Sent Escape", formattedOptions);
  });

  it("unbind removes a topic binding without killing the window", async () => {
    const reply = vi.fn();
    const unbindThread = vi.fn(() => "@5");
    const messageQueue = {
      clearStatusMsgInfo: vi.fn(),
      clearToolMsgIdsForTopic: vi.fn(),
      clearLastAssistantMessageId: vi.fn()
    };

    await unbindCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: reply as never
      },
      config,
      {
        getWindowForThread: () => "@5",
        getDisplayName: () => "project",
        unbindThread,
        resolveChatId: () => -100
      },
      {
        messageQueue
      }
    );

    expect(unbindThread).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(12345, 42);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Topic unbound"), formattedOptions);
  });

  it("kill removes the tmux window, unbinds, clears state, and deletes the topic", async () => {
    const reply = vi.fn();
    const killWindow = vi.fn(async () => true);
    const unbindThread = vi.fn();
    const deleteForumTopic = vi.fn(async () => true as const);
    const messageQueue = {
      clearStatusMsgInfo: vi.fn(),
      clearToolMsgIdsForTopic: vi.fn(),
      clearLastAssistantMessageId: vi.fn()
    };

    await killCommand(
      {
        from: { id: 12345 },
        msg: { message_thread_id: 42 },
        chat: { id: -100, type: "supergroup" },
        api: { deleteForumTopic },
        reply
      },
      config,
      {
        getWindowForThread: () => "@5",
        getDisplayName: () => "project",
        unbindThread,
        resolveChatId: () => -100
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        killWindow
      },
      {
        messageQueue
      }
    );

    expect(killWindow).toHaveBeenCalledWith("@5");
    expect(unbindThread).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(12345, 42);
    expect(deleteForumTopic).toHaveBeenCalledWith(-100, 42);
    expect(reply).not.toHaveBeenCalled();
  });

  it("builds screenshot keyboard callbacks", () => {
    const keyboard = buildScreenshotKeyboard("@5");
    const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data);

    expect(callbacks).toContain("kb:up:@5");
    expect(callbacks).toContain("kb:cc:@5");
    expect(callbacks).toContain("ss:ref:@5");
  });

  it("screenshot sends a PNG document for the bound window", async () => {
    const replyWithDocument = vi.fn();

    await screenshotCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: vi.fn() as never,
        replyWithDocument: replyWithDocument as never
      },
      config,
      {
        resolveWindowForThread: () => "@5",
        getDisplayName: () => "project"
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => "pane text")
      }
    );

    expect(replyWithDocument).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array)
        })
      })
    );
  });

  it("screenshot callback refreshes the document", async () => {
    const editMessageMedia = vi.fn();
    const answerCallbackQuery = vi.fn();

    await screenshotCallbackHandler(
      {
        from: { id: 12345 } as never,
        callbackQuery: { data: "ss:ref:@5" } as never,
        editMessageMedia: editMessageMedia as never,
        answerCallbackQuery: answerCallbackQuery as never
      },
      config,
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => "pane text"),
        sendKeys: vi.fn()
      },
      { refreshDelayMs: 0 }
    );

    expect(editMessageMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: "document", media: expect.any(Object) }),
      expect.objectContaining({ reply_markup: expect.any(Object) })
    );
    expect(answerCallbackQuery).toHaveBeenCalledWith("Refreshed");
  });

  it("screenshot quick key sends tmux key and refreshes", async () => {
    const sendKeys = vi.fn(async () => true);
    const editMessageMedia = vi.fn();
    const answerCallbackQuery = vi.fn();

    await screenshotCallbackHandler(
      {
        from: { id: 12345 } as never,
        callbackQuery: { data: "kb:up:@5" } as never,
        editMessageMedia: editMessageMedia as never,
        answerCallbackQuery: answerCallbackQuery as never
      },
      config,
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(async () => "pane text"),
        sendKeys
      },
      { refreshDelayMs: 0 }
    );

    expect(sendKeys).toHaveBeenCalledWith("@5", "Up", { enter: false, literal: false });
    expect(answerCallbackQuery).toHaveBeenCalledWith("↑");
    expect(editMessageMedia).toHaveBeenCalled();
  });

  it("interactive callback sends a key and refreshes the UI", async () => {
    const sendKeys = vi.fn(async () => true);
    const answerCallbackQuery = vi.fn();
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 1 }))
    };

    await interactiveCallbackHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        callbackQuery: { data: "aq:up:@5" } as never,
        answerCallbackQuery: answerCallbackQuery as never
      },
      config,
      {
        resolveChatId: () => 100
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        capturePane: vi.fn(
          async () =>
            " Select model\n Switch between Claude models.\n\n   1. Default\n ❯ 2. Sonnet\n\n Enter to confirm · Esc to exit\n"
        ),
        sendKeys
      },
      api,
      { refreshDelayMs: 0 }
    );

    expect(sendKeys).toHaveBeenCalledWith("@5", "Up", { enter: false, literal: false });
    expect(api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Select model"),
      expect.objectContaining({ message_thread_id: 42 })
    );
    expect(answerCallbackQuery).toHaveBeenCalledWith("↑");
  });

  it("formats parsed usage output", () => {
    expect(formatUsageReply("Settings: Usage\n  Token balance\nEsc to exit")).toBe(
      "```\nToken balance\n```"
    );
  });

  it("usage sends /usage, captures pane, and dismisses the modal", async () => {
    const reply = vi.fn();
    const sendKeys = vi.fn(async () => true);

    await usageCommand(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        reply: reply as never
      },
      config,
      {
        resolveWindowForThread: () => "@5"
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        sendKeys,
        capturePane: vi.fn(async () => "Settings: Usage\n  Remaining\nEsc to exit")
      },
      { renderDelayMs: 0 }
    );

    expect(sendKeys).toHaveBeenNthCalledWith(1, "@5", "/usage");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "@5", "Escape", { enter: false, literal: false });
    expect(reply).toHaveBeenCalledWith("Remaining", formattedOptions);
  });

  it("forwards Claude slash commands and clears session after /clear", async () => {
    const reply = vi.fn();
    const clearWindowSession = vi.fn();
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);

    await forwardCommandHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42, text: "/clear@bot" } as never,
        chat: { id: -100, type: "supergroup" } as never,
        reply: reply as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        resolveWindowForThread: () => "@5",
        getDisplayName: () => "project",
        sendToWindow,
        clearWindowSession
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" }))
      }
    );

    expect(sendToWindow).toHaveBeenCalledWith("@5", "/clear");
    expect(clearWindowSession).toHaveBeenCalledWith("@5");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("project"), formattedOptions);
  });

  it("sets the command menu including Claude slash commands", async () => {
    const api = {
      deleteMyCommands: vi.fn(async () => true as const),
      setMyCommands: vi.fn(async () => true as const)
    };

    await setupBotCommands(api);

    expect(api.deleteMyCommands).toHaveBeenCalled();
    expect(api.setMyCommands).toHaveBeenCalledWith(BOT_COMMANDS);
    expect(BOT_COMMANDS.map((command) => command.command)).toEqual(
      expect.arrayContaining(["start", "history", "screenshot", "usage", "clear", "model"])
    );
  });

  it("continues when the command menu cannot be set", async () => {
    const api = {
      deleteMyCommands: vi.fn(async () => {
        throw new Error("Not Found");
      }),
      setMyCommands: vi.fn(async () => true as const)
    };
    const logger = { warn: vi.fn() };

    await expect(setupBotCommandsIfPossible(api, logger)).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to setup Telegram command menu; continuing without command menu.",
      expect.any(Error)
    );
    expect(api.setMyCommands).not.toHaveBeenCalled();
  });

  it("replies to unsupported content for authorized users", async () => {
    const reply = vi.fn();

    await unsupportedContentHandler({ from: { id: 12345 } as never, reply: reply as never }, config);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Only text and photo messages are supported"), formattedOptions);
  });
});

describe("bot photo handling", () => {
  const photoConfig = {
    ...config,
    telegramBotToken: "token",
    configDir: "/tmp/agent-connect"
  };

  it("downloads the largest photo and forwards the saved path to Claude", async () => {
    const reply = vi.fn();
    const replyWithChatAction = vi.fn();
    const downloadPhoto = vi.fn(async () => undefined);
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);
    const setGroupChatId = vi.fn();

    await photoMessageHandler(
      {
        from: { id: 12345 },
        msg: {
          message_thread_id: 42,
          caption: "look at this",
          photo: [
            { file_id: "small", file_unique_id: "small_id" },
            { file_id: "large", file_unique_id: "unique:large" }
          ]
        },
        chat: { id: -100, type: "supergroup" },
        api: { getFile: vi.fn() },
        reply,
        replyWithChatAction
      },
      photoConfig,
      {
        setGroupChatId,
        getWindowForThread: () => "@5",
        getDisplayName: () => "project",
        unbindThread: vi.fn(),
        sendToWindow
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" }))
      },
      {
        imagesDir: "/tmp/images",
        now: () => 1_710_000_000_000,
        downloadPhoto
      }
    );

    const expectedPath = "/tmp/images/1710000000_unique_large.jpg";
    expect(setGroupChatId).toHaveBeenCalledWith(12345, 42, -100);
    expect(downloadPhoto).toHaveBeenCalledWith({
      api: expect.any(Object),
      botToken: "token",
      fileId: "large",
      destination: expectedPath
    });
    expect(replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(sendToWindow).toHaveBeenCalledWith("@5", `look at this\n\n(image attached: ${expectedPath})`);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Image sent to Claude Code"), formattedOptions);
  });

  it("requires photos to be sent in a bound named topic", async () => {
    const reply = vi.fn();

    await photoMessageHandler(
      {
        from: { id: 12345 },
        msg: { message_thread_id: 42, photo: [{ file_id: "photo", file_unique_id: "unique" }] },
        chat: { id: -100, type: "supergroup" },
        api: { getFile: vi.fn() },
        reply
      },
      photoConfig,
      {
        setGroupChatId: vi.fn(),
        getWindowForThread: () => null,
        getDisplayName: () => "",
        unbindThread: vi.fn(),
        sendToWindow: vi.fn()
      },
      {
        findWindowById: vi.fn()
      }
    );

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("No session bound"), formattedOptions);
  });
});

describe("bot topic events", () => {
  it("kills the bound window and clears topic state when a topic closes", async () => {
    const unbindThread = vi.fn();
    const killWindow = vi.fn(async () => true);
    const messageQueue = {
      clearStatusMsgInfo: vi.fn(),
      clearToolMsgIdsForTopic: vi.fn(),
      clearLastAssistantMessageId: vi.fn()
    };
    const store = new BotStateStore();
    Object.assign(store.userData(12345), {
      _pending_thread_id: 42,
      _pending_thread_text: "pending"
    });

    await topicClosedHandler(
      {
        from: { id: 12345 },
        msg: { message_thread_id: 42 }
      },
      config,
      {
        getWindowForThread: () => "@5",
        getDisplayName: () => "project",
        unbindThread,
        resolveChatId: () => -100
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        killWindow
      },
      {
        messageQueue,
        stateStore: store
      }
    );

    expect(killWindow).toHaveBeenCalledWith("@5");
    expect(unbindThread).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearStatusMsgInfo).toHaveBeenCalledWith(12345, 42);
    expect(messageQueue.clearToolMsgIdsForTopic).toHaveBeenCalledWith(12345, 42);
    expect(store.userData(12345)._pending_thread_text).toBeUndefined();
  });

  it("syncs topic rename to tmux and display state", async () => {
    const renameWindow = vi.fn(async () => true);
    const updateDisplayName = vi.fn();

    await topicEditedHandler(
      {
        from: { id: 12345 },
        msg: {
          message_thread_id: 42,
          forum_topic_edited: { name: "new topic" }
        }
      },
      config,
      {
        getWindowForThread: () => "@5",
        getDisplayName: () => "project",
        updateDisplayName
      },
      {
        renameWindow
      }
    );

    expect(renameWindow).toHaveBeenCalledWith("@5", "new topic");
    expect(updateDisplayName).toHaveBeenCalledWith("@5", "new topic");
  });
});

describe("bot text and picker flow", () => {
  function* noBindings(): IterableIterator<[number, number, string]> {}

  it("shows an existing-window picker for an unbound topic", async () => {
    const store = new BotStateStore();
    const reply = vi.fn();
    const setTopicProbeMessageId = vi.fn();

    await textMessageHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_id: 777, message_thread_id: 42, text: "hello" } as never,
        chat: { id: -100, type: "supergroup" } as never,
        reply: reply as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        getWindowForThread: () => null,
        iterThreadBindings: noBindings,
        getDisplayName: () => "",
        unbindThread: vi.fn(),
        sendToWindow: vi.fn(),
        setTopicProbeMessageId
      },
      {
        listWindows: vi.fn(async () => [
          { windowId: "@5", windowName: "project", cwd: "/tmp/project", paneCurrentCommand: "" }
        ]),
        findWindowById: vi.fn()
      },
      store
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Bind to Existing Window"),
      expect.objectContaining({ reply_markup: expect.any(Object) })
    );
    expect(store.userData(12345)).toMatchObject({
      state: "selecting_window",
      unbound_windows: ["@5"],
      _pending_thread_id: 42,
      _pending_thread_text: "hello"
    });
    expect(setTopicProbeMessageId).toHaveBeenCalledWith(12345, 42, 777);
  });

  it("shows an existing-window picker in a private chat", async () => {
    const store = new BotStateStore();
    const reply = vi.fn();

    await textMessageHandler(
      {
        from: { id: 12345 } as never,
        msg: { text: "hello" } as never,
        chat: { id: 12345, type: "private" } as never,
        reply: reply as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        getWindowForThread: () => null,
        iterThreadBindings: noBindings,
        getDisplayName: () => "",
        unbindThread: vi.fn(),
        sendToWindow: vi.fn()
      },
      {
        listWindows: vi.fn(async () => [
          { windowId: "@5", windowName: "project", cwd: "/tmp/project", paneCurrentCommand: "" }
        ]),
        findWindowById: vi.fn()
      },
      store
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Bind to Existing Window"),
      expect.objectContaining({ reply_markup: expect.any(Object) })
    );
    expect(store.userData(12345)).toMatchObject({
      state: "selecting_window",
      unbound_windows: ["@5"],
      _pending_thread_id: 0,
      _pending_thread_text: "hello"
    });
  });

  it("starts bash output capture after sending a bang command", async () => {
    const store = new BotStateStore();
    const bashCapture = {
      cancel: vi.fn(),
      start: vi.fn(),
      cancelAll: vi.fn()
    };
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);

    await textMessageHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42, text: "!ls -la" } as never,
        chat: { id: -100, type: "supergroup" } as never,
        reply: vi.fn() as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        getWindowForThread: () => "@5",
        iterThreadBindings: noBindings,
        getDisplayName: () => "project",
        unbindThread: vi.fn(),
        sendToWindow
      },
      {
        listWindows: vi.fn(),
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" }))
      },
      store,
      {
        bashCapture
      }
    );

    expect(bashCapture.cancel).toHaveBeenCalledWith(12345, 42);
    expect(sendToWindow).toHaveBeenCalledWith("@5", "!ls -la");
    expect(bashCapture.start).toHaveBeenCalledWith(12345, 42, "@5", "ls -la");
  });

  it("binds an existing window and forwards pending text", async () => {
    const store = new BotStateStore();
    Object.assign(store.userData(12345), {
      state: "selecting_window",
      unbound_windows: ["@5"],
      _pending_thread_id: 42,
      _pending_thread_text: "hello"
    });
    const bindThread = vi.fn();
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);
    const editMessageText = vi.fn();
    const answerCallbackQuery = vi.fn();

    await pickerCallbackHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        chat: { id: -100, type: "supergroup" } as never,
        callbackQuery: { data: "wb:sel:0" } as never,
        editMessageText: editMessageText as never,
        answerCallbackQuery: answerCallbackQuery as never,
        reply: vi.fn() as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        bindThread,
        listSessionsForDirectory: vi.fn(),
        waitForSessionMapEntry: vi.fn(),
        getWindowState: vi.fn(),
        saveState: vi.fn(),
        sendToWindow
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        createWindow: vi.fn()
      },
      store
    );

    expect(bindThread).toHaveBeenCalledWith(12345, 42, "@5", "project");
    expect(sendToWindow).toHaveBeenCalledWith("@5", "hello");
    expect(editMessageText).toHaveBeenCalledWith("✅ Bound to window project", formattedOptions);
    expect(answerCallbackQuery).toHaveBeenCalledWith("Bound");
    expect(store.userData(12345)._pending_thread_text).toBeUndefined();
  });

  it("binds an existing window from a private chat callback", async () => {
    const store = new BotStateStore();
    Object.assign(store.userData(12345), {
      state: "selecting_window",
      unbound_windows: ["@5"],
      _pending_thread_id: 0,
      _pending_thread_text: "hello"
    });
    const bindThread = vi.fn();
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);

    await pickerCallbackHandler(
      {
        from: { id: 12345 } as never,
        msg: {} as never,
        chat: { id: 12345, type: "private" } as never,
        callbackQuery: { data: "wb:sel:0" } as never,
        editMessageText: vi.fn() as never,
        answerCallbackQuery: vi.fn() as never,
        reply: vi.fn() as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        bindThread,
        listSessionsForDirectory: vi.fn(),
        waitForSessionMapEntry: vi.fn(),
        getWindowState: vi.fn(),
        saveState: vi.fn(),
        sendToWindow
      },
      {
        findWindowById: vi.fn(async () => ({ windowId: "@5", windowName: "project", cwd: "/tmp", paneCurrentCommand: "" })),
        createWindow: vi.fn()
      },
      store
    );

    expect(bindThread).toHaveBeenCalledWith(12345, 0, "@5", "project");
    expect(sendToWindow).toHaveBeenCalledWith("@5", "hello");
  });

  it("creates a new window from directory confirmation and forwards pending text", async () => {
    const store = new BotStateStore();
    Object.assign(store.userData(12345), {
      state: "browsing_directory",
      browse_path: "/tmp/project",
      _pending_thread_id: 42,
      _pending_thread_text: "start work"
    });
    const bindThread = vi.fn();
    const sendToWindow = vi.fn(async () => [true, "ok"] as [boolean, string]);
    const createWindow = vi.fn(async () => [
      true,
      "Created window 'project' at /tmp/project",
      "project",
      "@8"
    ] as [boolean, string, string, string]);
    const editMessageText = vi.fn();
    const answerCallbackQuery = vi.fn();

    await pickerCallbackHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        chat: { id: -100, type: "supergroup" } as never,
        callbackQuery: { data: "db:confirm" } as never,
        editMessageText: editMessageText as never,
        answerCallbackQuery: answerCallbackQuery as never,
        reply: vi.fn() as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        bindThread,
        listSessionsForDirectory: vi.fn(async () => []),
        waitForSessionMapEntry: vi.fn(async () => true),
        getWindowState: vi.fn(),
        saveState: vi.fn(),
        sendToWindow
      },
      {
        findWindowById: vi.fn(),
        createWindow
      },
      store
    );

    expect(createWindow).toHaveBeenCalledWith("/tmp/project", { resumeSessionId: null });
    expect(bindThread).toHaveBeenCalledWith(12345, 42, "@8", "project");
    expect(sendToWindow).toHaveBeenCalledWith("@8", "start work");
    expect(editMessageText).toHaveBeenCalledWith(expect.stringContaining("Created window"), formattedOptions);
    expect(answerCallbackQuery).toHaveBeenCalledWith("Created");
  });

  it("resumes a selected existing session", async () => {
    const store = new BotStateStore();
    Object.assign(store.userData(12345), {
      state: "selecting_session",
      cached_sessions: [
        { sessionId: "s1", summary: "old task", messageCount: 3, filePath: "/tmp/project/s1.jsonl" }
      ],
      _selected_path: "/tmp/project",
      _pending_thread_id: 42,
      _pending_thread_text: "continue"
    });
    const windowState = new WindowState("new-hook-id", "", "");
    const saveState = vi.fn();
    const createWindow = vi.fn(async () => [
      true,
      "Created window 'project' at /tmp/project",
      "project",
      "@9"
    ] as [boolean, string, string, string]);

    await pickerCallbackHandler(
      {
        from: { id: 12345 } as never,
        msg: { message_thread_id: 42 } as never,
        chat: { id: -100, type: "supergroup" } as never,
        callbackQuery: { data: "rs:sel:0" } as never,
        editMessageText: vi.fn() as never,
        answerCallbackQuery: vi.fn() as never,
        reply: vi.fn() as never
      },
      config,
      {
        setGroupChatId: vi.fn(),
        bindThread: vi.fn(),
        listSessionsForDirectory: vi.fn(),
        waitForSessionMapEntry: vi.fn(async () => false),
        getWindowState: vi.fn(() => windowState),
        saveState,
        sendToWindow: vi.fn(async () => [true, "ok"] as [boolean, string])
      },
      {
        findWindowById: vi.fn(),
        createWindow
      },
      store
    );

    expect(createWindow).toHaveBeenCalledWith("/tmp/project", { resumeSessionId: "s1" });
    expect(windowState).toMatchObject({ sessionId: "s1", cwd: "/tmp/project", windowName: "project" });
    expect(saveState).toHaveBeenCalled();
  });
});
