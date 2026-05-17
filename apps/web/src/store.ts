import { create } from "zustand";

export interface PublicBotConfig {
  id: string;
  name: string;
  telegramBotTokenSet: boolean;
  allowedUsers: number[];
  agentType: AgentType;
  tmuxSessionName: string;
  claudeCommand: string;
  openaiApiKeySet: boolean;
  openaiBaseUrl: string;
  monitorPollInterval: number;
  showUserMessages: boolean;
  showToolCalls: boolean;
  showHiddenDirs: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BotRuntimeStatus {
  id: string;
  running: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

export interface BotStatus {
  id: string;
  enabled: boolean;
  agentType: AgentType;
  telegramBotTokenSet: boolean;
  openaiApiKeySet: boolean;
  allowedUsers: number[];
  tmuxSessionName: string;
  runtime: BotRuntimeStatus;
  activeBots: number;
}

export interface BotTestResult {
  ok: boolean;
  latencyMs: number;
  runtimeRunning: boolean;
  proxy: string;
  botId: number | null;
  username: string | null;
  firstName: string | null;
  error: string | null;
}

interface BotMutationResponse extends PublicBotConfig {
  runtimeApplied: boolean;
  runtimeAction: "none" | "started" | "restarted" | "stopped";
  activeBots: number;
}

export interface BotDraft {
  id: string;
  name: string;
  telegramBotToken: string;
  allowedUsersText: string;
  agentType: AgentType;
  tmuxSessionName: string;
  claudeCommand: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  monitorPollInterval: string;
  showUserMessages: boolean;
  showToolCalls: boolean;
  showHiddenDirs: boolean;
  enabled: boolean;
}

interface BotCreatePayload {
  id?: string;
  name: string;
  telegramBotToken: string;
  allowedUsers: number[];
  agentType: AgentType;
  tmuxSessionName?: string;
  claudeCommand?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  monitorPollInterval?: number;
  showUserMessages: boolean;
  showToolCalls: boolean;
  showHiddenDirs: boolean;
  enabled: boolean;
}

type BotPatchPayload = Partial<Omit<BotCreatePayload, "id">>;
export type AgentType = "claude" | "codex";

interface BotStore {
  bots: PublicBotConfig[];
  selectedId: string | null;
  mode: "create" | "edit";
  draft: BotDraft;
  statusById: Record<string, BotStatus>;
  testResultById: Record<string, BotTestResult>;
  loading: boolean;
  saving: boolean;
  testing: boolean;
  error: string | null;
  notice: string | null;
  loadBots: () => Promise<void>;
  loadBotStatus: (id: string) => Promise<void>;
  testSelected: () => Promise<void>;
  selectBot: (id: string) => void;
  startCreate: () => void;
  updateDraft: <K extends keyof BotDraft>(key: K, value: BotDraft[K]) => void;
  saveDraft: () => Promise<void>;
  deleteSelected: () => Promise<void>;
}

const emptyDraft: BotDraft = {
  id: "",
  name: "",
  telegramBotToken: "",
  allowedUsersText: "",
  agentType: "claude",
  tmuxSessionName: "",
  claudeCommand: "claude --permission-mode bypassPermissions",
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  monitorPollInterval: "2",
  showUserMessages: false,
  showToolCalls: false,
  showHiddenDirs: false,
  enabled: true
};

export const useBotStore = create<BotStore>((set, get) => ({
  bots: [],
  selectedId: null,
  mode: "create",
  draft: emptyDraft,
  statusById: {},
  testResultById: {},
  loading: false,
  saving: false,
  testing: false,
  error: null,
  notice: null,

  async loadBots() {
    set({ loading: true, error: null });
    try {
      const response = await fetch("/api/bots");
      if (!response.ok) throw new Error(await responseText(response));
      const data = (await response.json()) as { bots: PublicBotConfig[] };
      const current = get();
      const selected =
        current.mode === "edit" && current.selectedId && data.bots.some((bot) => bot.id === current.selectedId)
          ? current.selectedId
          : (data.bots[0]?.id ?? null);
      const selectedBot = selected ? data.bots.find((bot) => bot.id === selected) : null;
      set({
        bots: data.bots,
        selectedId: selected,
        mode: selectedBot ? "edit" : "create",
        draft: selectedBot ? draftFromBot(selectedBot) : emptyDraft,
        loading: false
      });
      if (selected) void get().loadBotStatus(selected);
    } catch (error) {
      set({ error: messageFromError(error), loading: false });
    }
  },

  async loadBotStatus(id) {
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(id)}/status`);
      if (!response.ok) throw new Error(await responseText(response));
      const status = (await response.json()) as BotStatus;
      set((state) => ({
        statusById: {
          ...state.statusById,
          [id]: status
        }
      }));
    } catch (error) {
      set({ error: messageFromError(error) });
    }
  },

  async testSelected() {
    const id = get().selectedId;
    if (!id) return;
    set({ testing: true, error: null, notice: null });
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(id)}/test`, {
        method: "POST"
      });
      if (!response.ok) throw new Error(await responseText(response));
      const result = (await response.json()) as BotTestResult;
      set((state) => ({
        testResultById: {
          ...state.testResultById,
          [id]: result
        },
        testing: false,
        notice: result.ok ? `Telegram connected in ${result.latencyMs} ms.` : null,
        error: result.ok ? null : (result.error ?? "Telegram connectivity test failed")
      }));
      void get().loadBotStatus(id);
    } catch (error) {
      set({ error: messageFromError(error), testing: false });
    }
  },

  selectBot(id) {
    const bot = get().bots.find((entry) => entry.id === id);
    if (!bot) return;
    set({
      selectedId: id,
      mode: "edit",
      draft: draftFromBot(bot),
      error: null,
      notice: null
    });
    void get().loadBotStatus(id);
  },

  startCreate() {
    set({
      selectedId: null,
      mode: "create",
      draft: { ...emptyDraft },
      error: null,
      notice: null
    });
  },

  updateDraft(key, value) {
    set((state) => ({
      draft: nextDraft(state.draft, key, value)
    }));
  },

  async saveDraft() {
    const state = get();
    set({ saving: true, error: null, notice: null });
    try {
      const allowedUsers = parseAllowedUsers(state.draft.allowedUsersText);
      const response =
        state.mode === "create"
          ? await fetch("/api/bots", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(createPayload(state.draft, allowedUsers))
            })
          : await fetch(`/api/bots/${encodeURIComponent(state.selectedId ?? "")}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patchPayload(state.draft, allowedUsers))
            });
      if (!response.ok) throw new Error(await responseText(response));
      const saved = (await response.json()) as BotMutationResponse;
      set((current) => ({
        bots: upsertBot(current.bots, saved),
        selectedId: saved.id,
        mode: "edit",
        draft: draftFromBot(saved),
        saving: false,
        notice: runtimeNotice(saved)
      }));
      void get().loadBotStatus(saved.id);
    } catch (error) {
      set({ error: messageFromError(error), saving: false });
    }
  },

  async deleteSelected() {
    const selectedId = get().selectedId;
    if (!selectedId) return;
    set({ saving: true, error: null, notice: null });
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(selectedId)}`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error(await responseText(response));
      const result = (await response.json()) as Pick<BotMutationResponse, "runtimeAction" | "runtimeApplied">;
      const bots = get().bots.filter((bot) => bot.id !== selectedId);
      const next = bots[0] ?? null;
      set({
        bots,
        selectedId: next?.id ?? null,
        mode: next ? "edit" : "create",
        draft: next ? draftFromBot(next) : { ...emptyDraft },
        statusById: omitKey(get().statusById, selectedId),
        testResultById: omitKey(get().testResultById, selectedId),
        saving: false,
        notice: result.runtimeApplied ? "Deleted and stopped." : "Deleted."
      });
      if (next) void get().loadBotStatus(next.id);
    } catch (error) {
      set({ error: messageFromError(error), saving: false });
    }
  }
}));

function draftFromBot(bot: PublicBotConfig): BotDraft {
  return {
    id: bot.id,
    name: bot.name,
    telegramBotToken: "",
    allowedUsersText: bot.allowedUsers.join(", "),
    agentType: bot.agentType,
    tmuxSessionName: bot.tmuxSessionName,
    claudeCommand: bot.claudeCommand,
    openaiApiKey: "",
    openaiBaseUrl: bot.openaiBaseUrl,
    monitorPollInterval: String(bot.monitorPollInterval),
    showUserMessages: bot.showUserMessages,
    showToolCalls: bot.showToolCalls,
    showHiddenDirs: bot.showHiddenDirs,
    enabled: bot.enabled
  };
}

function nextDraft<K extends keyof BotDraft>(draft: BotDraft, key: K, value: BotDraft[K]): BotDraft {
  const next = {
    ...draft,
    [key]: value
  };
  if (key !== "agentType") return next;

  const agentType = value as AgentType;
  if (!isDefaultCommand(draft.claudeCommand, draft.agentType)) return next;
  return {
    ...next,
    claudeCommand: defaultCommand(agentType)
  };
}

function createPayload(draft: BotDraft, allowedUsers: number[]): BotCreatePayload {
  if (!draft.name.trim()) throw new Error("Name is required");
  if (!draft.telegramBotToken.trim()) throw new Error("Telegram token is required");
  return stripUndefined({
    id: optionalString(draft.id),
    name: draft.name.trim(),
    telegramBotToken: draft.telegramBotToken.trim(),
    allowedUsers,
    agentType: draft.agentType,
    tmuxSessionName: optionalString(draft.tmuxSessionName),
    claudeCommand: optionalString(draft.claudeCommand),
    openaiApiKey: optionalString(draft.openaiApiKey),
    openaiBaseUrl: optionalString(draft.openaiBaseUrl),
    monitorPollInterval: optionalNumber(draft.monitorPollInterval),
    showUserMessages: draft.showUserMessages,
    showToolCalls: draft.showToolCalls,
    showHiddenDirs: draft.showHiddenDirs,
    enabled: draft.enabled
  }) as BotCreatePayload;
}

function patchPayload(draft: BotDraft, allowedUsers: number[]): BotPatchPayload {
  if (!draft.name.trim()) throw new Error("Name is required");
  return stripUndefined({
    name: draft.name.trim(),
    telegramBotToken: optionalString(draft.telegramBotToken),
    allowedUsers,
    tmuxSessionName: optionalString(draft.tmuxSessionName),
    claudeCommand: optionalString(draft.claudeCommand),
    openaiApiKey: optionalString(draft.openaiApiKey),
    openaiBaseUrl: optionalString(draft.openaiBaseUrl),
    monitorPollInterval: optionalNumber(draft.monitorPollInterval),
    showUserMessages: draft.showUserMessages,
    showToolCalls: draft.showToolCalls,
    showHiddenDirs: draft.showHiddenDirs,
    enabled: draft.enabled
  }) as BotPatchPayload;
}

function parseAllowedUsers(value: string): number[] {
  const users = value
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter(Number.isSafeInteger);
  if (users.length === 0) throw new Error("Allowed users are required");
  return [...new Set(users)];
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNumber(value: string): number | undefined {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

function defaultCommand(agentType: AgentType): string {
  return agentType === "codex" ? "codex --yolo" : "claude --permission-mode bypassPermissions";
}

function isDefaultCommand(command: string, agentType: AgentType): boolean {
  return command.trim() === defaultCommand(agentType);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function upsertBot(bots: PublicBotConfig[], saved: PublicBotConfig): PublicBotConfig[] {
  const exists = bots.some((bot) => bot.id === saved.id);
  if (!exists) return [...bots, saved];
  return bots.map((bot) => (bot.id === saved.id ? saved : bot));
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function runtimeNotice(response: BotMutationResponse): string {
  if (!response.runtimeApplied) return "Saved. Runtime is not enabled in this process.";
  switch (response.runtimeAction) {
    case "started":
      return "Saved and started.";
    case "restarted":
      return "Saved and restarted.";
    case "stopped":
      return "Saved and stopped.";
    case "none":
      return "Saved.";
  }
}

async function responseText(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { error?: string };
    return value.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
