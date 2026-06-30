import axios from "axios";

export const api = axios.create({ baseURL: "/api" });

// Attach stored token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  },
);

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthStatus =
  | "unauthenticated"
  | "pending_code"
  | "pending_2fa"
  | "authenticated"
  | "session_expired";

export type TgAppClient = {
  id: string;
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
  isDefault: boolean;
};

export type Account = {
  id: number;
  name: string;
  phoneNumber: string;
  apiId: number;
  authStatus: AuthStatus;
  proxyId: string | null;
  disabled: boolean;
  appClientId: string | null;
  createdAt: string;
  sortOrder: number;
  tgDisplayName: string | null;
  tgUsername: string | null;
};

export type AccountExportItem = {
  name: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString: string | null;
  authStatus: string;
  proxyId: string | null;
  appClientId: string | null;
  disabled: boolean;
};

export type AccountExportPayload = {
  version: "1";
  exportedAt: string;
  accounts: AccountExportItem[];
};

export type TgSpamStatus = {
  spamStatus: "free" | "limited" | "blocked" | "frozen" | "unknown";
  rawMessage: string;
};

export type TgAccountStatus = {
  isActive: boolean;
  isDeleted: boolean;
  isRestricted: boolean;
  restrictions: Array<{ platform: string; reason: string; text: string }>;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  markWatched?: boolean;
  proxyId?: string;
};

export type Proxy = {
  id: string;
  name: string;
  url: string;
};

export type CustomAction =
  | { type: "send_command"; content: string; maxRetries?: number }
  | {
      type: "wait_reply";
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
    }
  | { type: "delay"; waitMs: number }
  | {
      type: "click_button";
      button: string;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
    }
  | {
      type: "enter_captcha";
      maxWaitMs: number;
      captchaLength?: number;
      maxRetries?: number;
    };

export type CustomConfig = {
  actions: CustomAction[];
  maxRetries?: number;
  proxyId?: string;
};

export type CustomStepLog = {
  step: number;
  actionType: string;
  label: string;
  preClickHtml?: string;
  preClickImage?: string;
  preClickButtons?: string[][];
  preClickHasMedia?: boolean;
  clickedButton?: string;
  responseHtml?: string;
  responseImage?: string;
  responseButtons?: string[][];
  responseHasMedia?: boolean;
  callbackAnswer?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  aiPrompt?: string;
  aiResponse?: string;
  aiDurationMs?: number;
  aiRetries?: string[];
  // Dev fields
  msgCount?: number;
  responseSource?: "edit" | "new_message";
  retryCount?: number;
  errorName?: string;
  /** 1-based job attempt number (only set when job maxRetries > 1) */
  jobAttempt?: number;
  /** 1-based action attempt number (only set when action maxRetries > 0) */
  actionAttempt?: number;
};

export type Job = {
  id: number;
  name: string;
  accountId: number | null;
  accountName?: string;
  jobType: "checkin" | "embywatch" | "custom";
  /** checkin: Telegram bot username. embywatch: Emby server URL */
  botUsername: string;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  createdAt: string;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  templateId?: number | null;
  runEveryDays: number;
};

export type JobTemplate = {
  id: number;
  name: string;
  jobType: "checkin" | "embywatch" | "custom";
  botUsername: string;
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  createdAt: string;
  linkedJobCount?: number;
  runEveryDays: number;
};

export type EmbywatchLog = {
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeSeconds: number;
  startSeconds: number;
  endSeconds: number;
  watchedSeconds: number;
  markedWatched: boolean;
};

export type CheckinAttemptLog = {
  attempt: number;
  commandSent: string;
  hasMedia: boolean;
  commandResponseHtml: string;
  commandResponseImages?: string[];
  availableButtons: string[][];
  buttonClicked?: string;
  callbackAnswer?: string;
  buttonResponseHtml?: string;
  buttonResponseHasMedia?: boolean;
  buttonResponseImage?: string;
  buttonResponseButtons?: string[][];
  aiDurationMs?: number;
  aiPrompt?: string;
  aiResponse?: string;
  aiRetries?: string[];
  error?: string;
  // Dev timing fields
  connectMs?: number;
  replyLatencyMs?: number;
  buttonClickMs?: number;
  buttonResponseMs?: number;
  buttonResponseSource?: "edit" | "new_message";
  totalMs?: number;
  replyTimeoutMs?: number;
  errorName?: string;
};

export type Log = {
  id: number;
  jobId: number;
  jobName: string | null;
  jobType: string | null;
  accountName: string | null;
  ranAt: string;
  status: "success" | "failed" | "running";
  message: string | null;
  retired: boolean;
  detail?:
    | CheckinAttemptLog[]
    | EmbywatchLog[]
    | { steps: CustomStepLog[] }
    | null;
};

export type ScheduleStatus = {
  jobId: number;
  jobName: string;
  nextRun: string;
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  getCaptcha: () =>
    api
      .get<{ svg: string; captchaToken: string }>("/auth/captcha")
      .then((r) => r.data),
  login: (
    username: string,
    password: string,
    captchaToken: string,
    captchaAnswer: string,
  ) =>
    api
      .post<{
        token: string;
      }>("/auth/login", { username, password, captchaToken, captchaAnswer })
      .then((r) => r.data),
  changeCredentials: (
    currentPassword: string,
    username?: string,
    newPassword?: string,
  ) =>
    api
      .put<{
        message: string;
      }>("/auth/credentials", { currentPassword, username, newPassword })
      .then((r) => r.data),
};

// ── Accounts ─────────────────────────────────────────────────────────────────

export const accountsApi = {
  list: () => api.get<Account[]>("/accounts").then((r) => r.data),
  create: (
    data: Omit<
      Account,
      "id" | "authStatus" | "createdAt" | "disabled" | "sortOrder" | "tgDisplayName" | "tgUsername"
    > & {
      apiHash: string;
    },
  ) => api.post<Account>("/accounts", data).then((r) => r.data),
  update: (
    id: number,
    data: Partial<Account> & { apiHash?: string; proxyId?: string | null },
  ) => api.put<Account>(`/accounts/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/accounts/${id}`),
  requestCode: (id: number) =>
    api
      .post<{
        message: string;
        isCodeViaApp: boolean;
      }>(`/accounts/${id}/auth/request`)
      .then((r) => r.data),
  resendCode: (id: number) =>
    api.post(`/accounts/${id}/auth/resend`).then((r) => r.data),
  verify: (id: number, data: { code?: string; password?: string }) =>
    api
      .post<{ step: string }>(`/accounts/${id}/auth/verify`, data)
      .then((r) => r.data),
  checkStatus: (id: number) =>
    api
      .post<TgAccountStatus>(`/accounts/${id}/check-status`)
      .then((r) => r.data),
  refreshTgMeta: (id: number) =>
    api
      .post<{ tgDisplayName: string | null; tgUsername: string | null }>(`/accounts/${id}/refresh-tg-meta`)
      .then((r) => r.data),
  export: (ids?: number[]) =>
    api
      .post<AccountExportPayload>("/accounts/export", { ids: ids ?? [] })
      .then((r) => r.data),
  import: (accounts: AccountExportItem[]) =>
    api
      .post<{ imported: number; skipped: number }>("/accounts/import", {
        accounts,
      })
      .then((r) => r.data),
  checkSpam: (id: number) =>
    api.post<TgSpamStatus>(`/accounts/${id}/check-spam`).then((r) => r.data),
  checkEnabledSessions: () =>
    api
      .post<{
        checked: number;
        expired: number[];
      }>("/accounts/check-enabled-sessions")
      .then((r) => r.data),
  reorder: (items: Array<{ id: number; sortOrder: number }>) =>
    api.put("/accounts/reorder", { items }).then((r) => r.data),
  forceReauth: (id: number) =>
    api.post<Account>(`/accounts/${id}/force-reauth`).then((r) => r.data),
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const jobsApi = {
  list: () => api.get<Job[]>("/jobs").then((r) => r.data),
  create: (data: Partial<Job>) =>
    api.post<Job>("/jobs", data).then((r) => r.data),
  update: (id: number, data: Partial<Job>) =>
    api.put<Job>(`/jobs/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/jobs/${id}`),
  run: (id: number) =>
    api
      .post<{ message: string; logId: number }>(`/jobs/${id}/run`)
      .then((r) => r.data),
};

// ── Templates ────────────────────────────────────────────────────────────────

export type AvailableAccount = {
  id: number;
  name: string;
  phoneNumber: string;
  authStatus: AuthStatus;
};

export const templatesApi = {
  list: () => api.get<JobTemplate[]>("/templates").then((r) => r.data),
  create: (data: Partial<JobTemplate>) =>
    api.post<JobTemplate>("/templates", data).then((r) => r.data),
  update: (id: number, data: Partial<JobTemplate>) =>
    api.put<JobTemplate>(`/templates/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/templates/${id}`),
  setLinkedJobsEnabled: (id: number, enabled: boolean) =>
    api
      .put<{ ok: boolean }>(`/templates/${id}/jobs/enabled`, { enabled })
      .then((r) => r.data),
  availableAccounts: (id: number) =>
    api
      .get<AvailableAccount[]>(`/templates/${id}/available-accounts`)
      .then((r) => r.data),
  createJobs: (
    id: number,
    data: {
      jobs: Array<{
        accountId: number;
        name: string;
        config?: Record<string, unknown>;
      }>;
      scheduleWindowStart: number;
      scheduleWindowEnd: number;
    },
  ) =>
    api
      .post<{
        created: number;
        ids: number[];
      }>(`/templates/${id}/create-jobs`, data)
      .then((r) => r.data),
};

// ── Logs ─────────────────────────────────────────────────────────────────────

export const logsApi = {
  list: (params?: {
    jobId?: number;
    limit?: number;
    offset?: number;
    showRetired?: boolean;
  }) =>
    api
      .get<
        Log[]
      >("/logs", { params: { ...params, showRetired: params?.showRetired ? "1" : "0" } })
      .then((r) => r.data),
  getOne: (id: number) => api.get<Log>(`/logs/${id}`).then((r) => r.data),
  cancel: (id: number) =>
    api.post<{ message: string }>(`/logs/${id}/cancel`).then((r) => r.data),
  retire: (id: number) =>
    api.patch<{ retired: boolean }>(`/logs/${id}/retire`).then((r) => r.data),
};

// ── Status ────────────────────────────────────────────────────────────────────

export const statusApi = {
  get: () => api.get<ScheduleStatus[]>("/status").then((r) => r.data),
};

// ── Settings ──────────────────────────────────────────────────────────────────

export type UAPreset = {
  name: string;
  value: string;
};

export type Settings = {
  default_timezone: string;
  default_max_retry: string;
  check_daily_run: string;
  default_ua: string;
  default_play_duration: string;
  default_device_name: string;
  ai_api_key: string;
  ai_model: string;
  notify_tg_username: string;
  notify_tg_events: string;
  ua_presets: string;
  proxies: string;
  tg_app_clients: string;
  tg_client_mode: string; // 'default' | 'random'
};

export const settingsApi = {
  get: () => api.get<Settings>("/settings").then((r) => r.data),
  update: (data: Partial<Settings>) =>
    api.put<Settings>("/settings", data).then((r) => r.data),
  testProxy: (url: string) =>
    api
      .post<{ ok: boolean; error?: string }>("/settings/test-proxy", { url })
      .then((r) => r.data),
};

// ── AI Suppliers ──────────────────────────────────────────────────────────────

export type AiModel = {
  id: number;
  supplier_id: number;
  model_id: string;
  label: string | null;
};

export type AiSupplier = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
  models: AiModel[];
};

export const aiSuppliersApi = {
  list: () => api.get<AiSupplier[]>("/ai-suppliers").then((r) => r.data),
  create: (data: Omit<AiSupplier, "id" | "models">) =>
    api.post<AiSupplier>("/ai-suppliers", data).then((r) => r.data),
  update: (id: number, data: Partial<Omit<AiSupplier, "id" | "models">>) =>
    api.put<AiSupplier>(`/ai-suppliers/${id}`, data).then((r) => r.data),
  remove: (id: number) => api.delete(`/ai-suppliers/${id}`).then((r) => r.data),
  addModel: (supplierId: number, model_id: string, label?: string) =>
    api
      .post<AiModel>(`/ai-suppliers/${supplierId}/models`, { model_id, label })
      .then((r) => r.data),
  removeModel: (supplierId: number, modelId: number) =>
    api
      .delete(`/ai-suppliers/${supplierId}/models/${modelId}`)
      .then((r) => r.data),
};

// ── Data Import / Export ───────────────────────────────────────────────────────

export type ExportPayload = {
  version: "1";
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  jobs: Array<{
    accountIndex: number | null;
    templateIndex?: number | null;
    name: string;
    jobType: string;
    botUsername: string;
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  settings: Record<string, string>;
};

export type ImportResult = {
  message: string;
  accountsImported: number;
  accountsSkipped: number;
  templatesImported: number;
  jobsImported: number;
  settingsUpdated: number;
};

export const dataApi = {
  export: () => api.get<ExportPayload>("/data/export").then((r) => r.data),
  import: (data: ExportPayload, mode: "merge" | "replace") =>
    api.post<ImportResult>("/data/import", { data, mode }).then((r) => r.data),
};

// ── TG Live Client ────────────────────────────────────────────────────────────

export type TgDialog = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  unreadCount: number;
  lastMessage: { text: string; date: number; fromMe: boolean } | null;
  left?: boolean; // not a member; join required to send messages
};

export type TgButton = {
  text: string;
  data: string | null;
  url: string | null;
  webApp: boolean; // Telegram Mini App -- must open in a real browser
};

export type TgReaction = {
  emoji: string;
  count: number;
  mine: boolean;
};

export type TgInvitePreview = {
  hash: string;
  title: string;
  memberCount: number;
  type: "group" | "channel";
  alreadyJoined: boolean;
  chatId?: string;
};

export type TgMessage = {
  id: number;
  text: string;
  html: string | null;
  date: number;
  fromMe: boolean;
  fromId: string | null;
  fromName: string | null;
  hasPhoto: boolean;
  hasDocument: boolean;
  buttons: TgButton[][] | null;
  reactions: TgReaction[] | null;
  replyToId: number | null;
  replyToText: string | null;
  replyToName: string | null;
  replyCount: number | null;
};

export type TgContact = {
  chatId: string;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string | null;
};

export type TgProfile = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  phone: string | null;
  bio: string | null;
  memberCount: number | null;
};

export type TgBotCommand = {
  command: string;
  description: string;
};

export type TgFolder = {
  id: number;
  title: string;
  emoticon: string | null;
  includeGroups: boolean;
  includeBroadcasts: boolean;
  includeBots: boolean;
  includeContacts: boolean;
  includeNonContacts: boolean;
  pinnedChatIds: string[];
  includedChatIds: string[];
  excludedChatIds: string[];
};

export const tgClientApi = {
  dialogs: (
    accountId: number,
    params?: { limit?: number },
    signal?: AbortSignal,
  ) =>
    api
      .get<TgDialog[]>(`/tg-client/${accountId}/dialogs`, { params, signal })
      .then((r) => r.data),

  messages: (
    accountId: number,
    chatId: string,
    params?: { limit?: number; offsetId?: number; fresh?: 1 },
    signal?: AbortSignal,
  ) =>
    api
      .get<
        TgMessage[]
      >(`/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}`, { params, signal })
      .then((r) => r.data),

  send: (
    accountId: number,
    chatId: string,
    text: string,
    replyToMsgId?: number,
  ) =>
    api
      .post<{
        id: number;
        date: number;
      }>(`/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}`, {
        text,
        ...(replyToMsgId ? { replyToMsgId } : {}),
      })
      .then((r) => r.data),

  contacts: (accountId: number) =>
    api
      .get<TgContact[]>(`/tg-client/${accountId}/contacts`)
      .then((r) => r.data),

  addContact: (
    accountId: number,
    phone: string,
    firstName: string,
    lastName?: string,
  ) =>
    api
      .post<TgContact>(`/tg-client/${accountId}/contacts`, {
        phone,
        firstName,
        lastName,
      })
      .then((r) => r.data),

  search: (accountId: number, q: string) =>
    api
      .get<TgDialog[]>(`/tg-client/${accountId}/search`, { params: { q } })
      .then((r) => r.data),

  photoUrl: (accountId: number, chatId: string, msgId: number) => {
    const token = localStorage.getItem("token") ?? "";
    return `/api/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/photo?token=${encodeURIComponent(token)}`;
  },

  eventsUrl: (accountId: number) => `/api/tg-client/${accountId}/events`,

  folders: (accountId: number) =>
    api.get<TgFolder[]>(`/tg-client/${accountId}/folders`).then((r) => r.data),

  avatarUrl: (accountId: number, chatId: string) => {
    const token = localStorage.getItem("token") ?? "";
    return `/api/tg-client/${accountId}/avatar/${encodeURIComponent(chatId)}?token=${encodeURIComponent(token)}`;
  },

  avatarsBatch: (accountId: number, chatIds: string[]) =>
    api
      .get<
        Record<string, string>
      >(`/tg-client/${accountId}/avatars?ids=${chatIds.map(encodeURIComponent).join(",")}`)
      .then((r) => r.data),

  profile: (accountId: number, chatId: string) =>
    api
      .get<TgProfile>(
        `/tg-client/${accountId}/profile/${encodeURIComponent(chatId)}`,
      )
      .then((r) => r.data),

  mute: (accountId: number, chatId: string, muteSecs: number) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/mute/${encodeURIComponent(chatId)}`, {
        muteSecs,
      })
      .then((r) => r.data),

  pin: (accountId: number, chatId: string, pinned: boolean) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/pin/${encodeURIComponent(chatId)}`, {
        pinned,
      })
      .then((r) => r.data),

  clickButton: (
    accountId: number,
    chatId: string,
    msgId: number,
    data: string,
  ) =>
    api
      .post<{
        alert: boolean;
        message: string | null;
        url: string | null;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/button`,
        { data },
      )
      .then((r) => r.data),

  clearCache: (accountId: number, chatId: string) =>
    api
      .delete(`/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/cache`)
      .then((r) => r.data),

  sendReaction: (
    accountId: number,
    chatId: string,
    msgId: number,
    emoji: string | null,
  ) =>
    api
      .post<{
        ok: boolean;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/reaction`,
        { emoji },
      )
      .then((r) => r.data),

  botCommands: (accountId: number, chatId: string) =>
    api
      .get<
        TgBotCommand[]
      >(`/tg-client/${accountId}/bot-commands/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  threadMessages: (
    accountId: number,
    chatId: string,
    msgId: number,
    params?: { limit?: number; offsetId?: number },
  ) =>
    api
      .get<
        TgMessage[]
      >(`/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/thread`, { params })
      .then((r) => r.data),

  markRead: (accountId: number, chatId: string, maxId: number) =>
    api
      .post(`/tg-client/${accountId}/mark-read/${encodeURIComponent(chatId)}`, {
        maxId,
      })
      .then((r) => r.data),

  resolvePeer: (accountId: number, username: string) =>
    api
      .post<TgDialog>(`/tg-client/${accountId}/resolve-peer`, { username })
      .then((r) => r.data),

  reconnect: (accountId: number) =>
    api.post(`/tg-client/${accountId}/reconnect`).then((r) => r.data),

  checkInvite: (accountId: number, hash: string) =>
    api
      .get<TgInvitePreview>(
        `/tg-client/${accountId}/invite/${encodeURIComponent(hash)}`,
      )
      .then((r) => r.data),

  joinInvite: (accountId: number, hash: string) =>
    api
      .post<TgDialog>(
        `/tg-client/${accountId}/invite/${encodeURIComponent(hash)}`,
      )
      .then((r) => r.data),

  join: (accountId: number, chatId: string) =>
    api
      .post<{
        ok: boolean;
        joined?: boolean;
        requestSent?: boolean;
      }>(`/tg-client/${accountId}/join/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  membership: (accountId: number, chatId: string) =>
    api
      .get<{
        member: boolean;
      }>(`/tg-client/${accountId}/membership/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  pinnedMessage: (accountId: number, chatId: string) =>
    api
      .get<TgMessage | null>(`/tg-client/${accountId}/chats/${encodeURIComponent(chatId)}/pinned`)
      .then((r) => r.data),

  startBot: (accountId: number, username: string, startParam: string) =>
    api
      .post<TgDialog>(`/tg-client/${accountId}/start-bot/${encodeURIComponent(username)}`, {
        startParam,
      })
      .then((r) => r.data),

  webviewResolve: (accountId: number, url: string, botChatId?: string | null) =>
    api
      .post<{ webAppUrl: string }>(`/tg-client/${accountId}/webview/resolve`, {
        url,
        botChatId,
      })
      .then((r) => r.data),
};

// ── AI Debug ──────────────────────────────────────────────────────────────────

export const debugApi = {
  runAi: (
    images: string[],
    prompt: string,
    maxTokens?: number,
    model?: string,
  ) =>
    api
      .post<{
        response: string;
        durationMs: number;
      }>("/debug/ai", { images, prompt, maxTokens, model })
      .then((r) => r.data),
};
