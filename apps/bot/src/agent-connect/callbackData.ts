export const CB_HISTORY_PREV = "hp:";
export const CB_HISTORY_NEXT = "hn:";

export const CB_DIR_SELECT = "db:sel:";
export const CB_DIR_UP = "db:up";
export const CB_DIR_CONFIRM = "db:confirm";
export const CB_DIR_CANCEL = "db:cancel";
export const CB_DIR_PAGE = "db:page:";

export const CB_WIN_BIND = "wb:sel:";
export const CB_WIN_NEW = "wb:new";
export const CB_WIN_CANCEL = "wb:cancel";

export const CB_SCREENSHOT_REFRESH = "ss:ref:";

export const CB_ASK_UP = "aq:up:";
export const CB_ASK_DOWN = "aq:down:";
export const CB_ASK_LEFT = "aq:left:";
export const CB_ASK_RIGHT = "aq:right:";
export const CB_ASK_ESC = "aq:esc:";
export const CB_ASK_ENTER = "aq:enter:";
export const CB_ASK_SPACE = "aq:spc:";
export const CB_ASK_TAB = "aq:tab:";
export const CB_ASK_REFRESH = "aq:ref:";

// Literal single-letter callbacks for Claude's session-quality survey
// (`y: Yes  n: No  d: Don't ask again`). The survey blocks the TUI input
// until answered — we detect it as a SessionSurvey pattern and surface
// three buttons that send the respective letter via send-keys -l.
export const CB_ASK_LITERAL_Y = "aq:lit-y:";
export const CB_ASK_LITERAL_N = "aq:lit-n:";
export const CB_ASK_LITERAL_D = "aq:lit-d:";

export const CB_SESSION_SELECT = "rs:sel:";
export const CB_SESSION_NEW = "rs:new";
export const CB_SESSION_CANCEL = "rs:cancel";

export const CB_KEYS_PREFIX = "kb:";
