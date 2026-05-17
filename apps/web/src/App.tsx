import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  Database,
  Info,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings2,
  Trash2
} from "lucide-react";
import { type AgentType, type BotDraft, type BotStatus, type BotTestResult, useBotStore } from "./store";

export function App() {
  const {
    bots,
    selectedId,
    mode,
    draft,
    loading,
    saving,
    testing,
    error,
    notice,
    statusById,
    testResultById,
    loadBots,
    loadBotStatus,
    testSelected,
    selectBot,
    startCreate,
    updateDraft,
    saveDraft,
    deleteSelected
  } = useBotStore();
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  useEffect(() => {
    if (selectedId) void loadBotStatus(selectedId);
  }, [loadBotStatus, selectedId]);

  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return bots;
    return bots.filter(
      (botConfig) =>
        botConfig.name.toLowerCase().includes(normalized) ||
        botConfig.id.toLowerCase().includes(normalized) ||
        botConfig.tmuxSessionName.toLowerCase().includes(normalized)
    );
  }, [bots, query]);
  const enabledCount = bots.filter((botConfig) => botConfig.enabled).length;
  const selectedBot = selectedId ? (bots.find((botConfig) => botConfig.id === selectedId) ?? null) : null;
  const selectedStatus = selectedId ? (statusById[selectedId] ?? null) : null;
  const selectedTestResult = selectedId ? (testResultById[selectedId] ?? null) : null;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void saveDraft();
  };

  const remove = () => {
    if (selectedId && window.confirm(`Delete ${selectedId}?`)) {
      void deleteSelected();
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Bot size={18} aria-hidden="true" />
          </div>
          <div>
            <div className="brand-name">Agent Connect</div>
            <div className="brand-subtitle">Console</div>
          </div>
        </div>

        <div className="sidebar-actions">
          <button className="icon-button" type="button" title="Refresh bots" onClick={() => void loadBots()}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button className="icon-button primary-icon" type="button" title="New bot" onClick={startCreate}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>

        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bots" />
        </label>

        <div className="metric-grid">
          <Metric icon={<Database size={15} aria-hidden="true" />} label="Bots" value={bots.length} />
          <Metric icon={<Server size={15} aria-hidden="true" />} label="Enabled" value={enabledCount} />
        </div>

        <nav className="bot-list" aria-label="Bot list">
          {filteredBots.map((botConfig) => (
            <button
              className={botConfig.id === selectedId ? "bot-row selected" : "bot-row"}
              type="button"
              key={botConfig.id}
              onClick={() => selectBot(botConfig.id)}
            >
              <span className={botConfig.enabled ? "status-dot enabled" : "status-dot"} />
                <span className="bot-row-main">
                  <span className="bot-row-name">{botConfig.name}</span>
                <span className="bot-row-id">
                  {botConfig.id} · {botConfig.tmuxSessionName}
                </span>
                </span>
              {botConfig.telegramBotTokenSet ? <Check size={14} aria-label="Token set" /> : null}
            </button>
          ))}
          {filteredBots.length === 0 ? <div className="empty-list">No bots</div> : null}
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">{mode === "create" ? "New bot" : selectedBot?.id}</div>
            <h1>{mode === "create" ? "Create bot" : selectedBot?.name}</h1>
          </div>
          <div className="topbar-actions">
            {mode === "edit" ? (
              <>
                <button className="ghost-button" type="button" onClick={() => void testSelected()} disabled={saving || testing}>
                  <Activity size={16} aria-hidden="true" />
                  {testing ? "Testing" : "Test"}
                </button>
                <button className="ghost-button danger" type="button" onClick={remove} disabled={saving || testing}>
                  <Trash2 size={16} aria-hidden="true" />
                  Delete
                </button>
              </>
            ) : null}
            <button className="solid-button" type="submit" form="bot-form" disabled={saving || testing}>
              <Save size={16} aria-hidden="true" />
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="notice" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            {error}
          </div>
        ) : null}

        {notice ? (
          <div className="notice success" role="status">
            <CircleCheck size={16} aria-hidden="true" />
            {notice}
          </div>
        ) : null}

        {mode === "edit" ? (
          <StatusPanel bot={selectedBot} status={selectedStatus} testResult={selectedTestResult} />
        ) : null}

        <form id="bot-form" className="editor-grid" onSubmit={submit}>
          <section className="surface wide">
            <SectionHeading icon={<Settings2 size={16} aria-hidden="true" />} title="General" />
            <div className="form-grid">
              <TextField label="ID" value={draft.id} disabled={mode === "edit"} onChange={bind(updateDraft, "id")} />
              <TextField label="Name" value={draft.name} onChange={bind(updateDraft, "name")} />
              <Toggle label="Enabled" checked={draft.enabled} onChange={bind(updateDraft, "enabled")} />
            </div>
          </section>

          <section className="surface">
            <SectionHeading icon={<Bot size={16} aria-hidden="true" />} title="Telegram" />
            <div className="field-stack">
              <TextField
                label="Bot token"
                value={draft.telegramBotToken}
                type="password"
                placeholder={selectedBot?.telegramBotTokenSet ? "Token is set" : ""}
                onChange={bind(updateDraft, "telegramBotToken")}
              />
              <TextField
                label="Allowed users"
                value={draft.allowedUsersText}
                onChange={bind(updateDraft, "allowedUsersText")}
              />
            </div>
          </section>

          <section className="surface">
            <SectionHeading icon={<Server size={16} aria-hidden="true" />} title="Runtime" />
            <div className="field-stack">
              <TextField
                label="tmux session"
                value={draft.tmuxSessionName}
                onChange={bind(updateDraft, "tmuxSessionName")}
              />
              <SelectField
                label="Agent"
                value={draft.agentType}
                options={[
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" }
                ]}
                disabled={mode === "edit"}
                onChange={bind(updateDraft, "agentType")}
              />
              <TextField label="Command" value={draft.claudeCommand} onChange={bind(updateDraft, "claudeCommand")} />
              <div className="field-hint">
                <Info size={14} aria-hidden="true" />
                {draft.agentType === "claude" ? (
                  <span>
                    Starts with <code>--permission-mode bypassPermissions</code> by default unless the command already sets a permission mode.
                  </span>
                ) : (
                  <span>
                    Starts Codex with <code>--yolo</code> and resumes picked sessions with <code>codex --yolo resume &lt;session-id&gt;</code>.
                  </span>
                )}
              </div>
              <TextField
                label="Poll interval"
                value={draft.monitorPollInterval}
                type="number"
                step="0.1"
                onChange={bind(updateDraft, "monitorPollInterval")}
              />
              <div className="toggle-stack">
                <Toggle
                  label="Echo user prompts"
                  checked={draft.showUserMessages}
                  onChange={bind(updateDraft, "showUserMessages")}
                />
                <Toggle
                  label="Intermediate messages"
                  checked={draft.showToolCalls}
                  onChange={bind(updateDraft, "showToolCalls")}
                />
                <Toggle
                  label="Hidden dirs"
                  checked={draft.showHiddenDirs}
                  onChange={bind(updateDraft, "showHiddenDirs")}
                />
              </div>
            </div>
          </section>

          <section className="surface wide">
            <SectionHeading icon={<Database size={16} aria-hidden="true" />} title="OpenAI" />
            <div className="form-grid two">
              <TextField
                label="API key"
                value={draft.openaiApiKey}
                type="password"
                placeholder={selectedBot?.openaiApiKeySet ? "Key is set" : ""}
                onChange={bind(updateDraft, "openaiApiKey")}
              />
              <TextField label="Base URL" value={draft.openaiBaseUrl} onChange={bind(updateDraft, "openaiBaseUrl")} />
            </div>
          </section>
        </form>

        {loading ? <div className="loading-line">Loading</div> : null}
      </main>
    </div>
  );
}

function StatusPanel({
  bot,
  status,
  testResult
}: {
  bot: { id: string; createdAt: string; updatedAt: string; telegramBotTokenSet: boolean; openaiApiKeySet: boolean } | null;
  status: BotStatus | null;
  testResult: BotTestResult | null;
}) {
  const running = status?.runtime.running ?? false;
  return (
    <section className="surface wide status-panel">
      <SectionHeading icon={<Info size={16} aria-hidden="true" />} title="Status" />
      <div className="detail-grid">
        <DetailItem label="ID" value={bot?.id ?? status?.id ?? "-"} />
        <StatusItem label="Runtime" value={running ? "Running" : "Stopped"} tone={running ? "good" : "muted"} />
        <DetailItem label="Agent" value={agentLabel(status?.agentType)} />
        <StatusItem label="Enabled" value={status?.enabled ? "Enabled" : "Disabled"} tone={status?.enabled ? "good" : "muted"} />
        <DetailItem label="Active bots" value={String(status?.activeBots ?? 0)} />
        <DetailItem label="tmux" value={status?.tmuxSessionName ?? "-"} />
        <DetailItem label="Allowed users" value={status?.allowedUsers.join(", ") || "-"} />
        <StatusItem
          label="Telegram token"
          value={status?.telegramBotTokenSet ?? bot?.telegramBotTokenSet ? "Set" : "Missing"}
          tone={status?.telegramBotTokenSet ?? bot?.telegramBotTokenSet ? "good" : "bad"}
        />
        <StatusItem
          label="OpenAI key"
          value={status?.openaiApiKeySet ?? bot?.openaiApiKeySet ? "Set" : "Not set"}
          tone={status?.openaiApiKeySet ?? bot?.openaiApiKeySet ? "good" : "muted"}
        />
        <DetailItem label="Started" value={formatDate(status?.runtime.startedAt)} />
        <DetailItem label="Updated" value={formatDate(bot?.updatedAt)} />
      </div>
      {status?.runtime.lastError ? <div className="inline-error">{status.runtime.lastError}</div> : null}
      {testResult ? <TestResult result={testResult} /> : null}
    </section>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusItem({ label, value, tone }: { label: string; value: string; tone: "good" | "bad" | "muted" }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong className={`status-text ${tone}`}>{value}</strong>
    </div>
  );
}

function TestResult({ result }: { result: BotTestResult }) {
  return (
    <div className={result.ok ? "test-result ok" : "test-result fail"}>
      <Activity size={15} aria-hidden="true" />
      <span>
        {result.ok
          ? `Telegram OK · @${result.username ?? "unknown"} · ${result.latencyMs} ms · proxy ${result.proxy}`
          : `Telegram failed · ${result.error ?? "unknown error"} · proxy ${result.proxy}`}
      </span>
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
      </div>
    </div>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="section-heading">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  step,
  placeholder,
  disabled = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  step?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        type={type}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function agentLabel(agentType: AgentType | undefined): string {
  return agentType === "codex" ? "Codex" : "Claude Code";
}

function bind<K extends keyof BotDraft>(
  updateDraft: <Key extends keyof BotDraft>(key: Key, value: BotDraft[Key]) => void,
  key: K
): (value: BotDraft[K]) => void {
  return (value) => updateDraft(key, value);
}
