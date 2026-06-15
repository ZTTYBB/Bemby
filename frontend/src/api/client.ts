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
  | "authenticated";

export type Account = {
  id: number;
  name: string;
  phoneNumber: string;
  apiId: number;
  authStatus: AuthStatus;
  createdAt: string;
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  markWatched?: boolean;
};

export type CustomAction =
  | { type: 'send_command'; content: string }
  | { type: 'wait_reply'; maxWaitMs: number }
  | { type: 'delay'; waitMs: number }
  | { type: 'click_button'; button: string; maxRetries: number; maxWaitMs: number };

export type CustomConfig = {
  actions: CustomAction[];
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
  // Dev fields
  msgCount?: number;
  responseSource?: 'edit' | 'new_message';
  retryCount?: number;
  errorName?: string;
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
  error?: string;
  // Dev timing fields
  connectMs?: number;
  replyLatencyMs?: number;
  buttonClickMs?: number;
  buttonResponseMs?: number;
  buttonResponseSource?: 'edit' | 'new_message';
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
  detail?: CheckinAttemptLog[] | EmbywatchLog[] | { steps: CustomStepLog[] } | null;
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
    data: Omit<Account, "id" | "authStatus" | "createdAt"> & {
      apiHash: string;
    },
  ) => api.post<Account>("/accounts", data).then((r) => r.data),
  update: (id: number, data: Partial<Account> & { apiHash?: string }) =>
    api.put<Account>(`/accounts/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/accounts/${id}`),
  requestCode: (id: number) =>
    api
      .post<{ message: string }>(`/accounts/${id}/auth/request`)
      .then((r) => r.data),
  verify: (id: number, data: { code?: string; password?: string }) =>
    api
      .post<{ step: string }>(`/accounts/${id}/auth/verify`, data)
      .then((r) => r.data),
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

// ── Logs ─────────────────────────────────────────────────────────────────────

export const logsApi = {
  list: (params?: { jobId?: number; limit?: number; offset?: number }) =>
    api.get<Log[]>("/logs", { params }).then((r) => r.data),
  getOne: (id: number) => api.get<Log>(`/logs/${id}`).then((r) => r.data),
  cancel: (id: number) =>
    api.post<{ message: string }>(`/logs/${id}/cancel`).then((r) => r.data),
};

// ── Status ────────────────────────────────────────────────────────────────────

export const statusApi = {
  get: () => api.get<ScheduleStatus[]>("/status").then((r) => r.data),
};

// ── Settings ──────────────────────────────────────────────────────────────────

export type Settings = {
  default_timezone: string;
  default_max_retry: string;
  check_daily_run: string;
  default_ua: string;
  default_play_duration: string;
  default_device_name: string;
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_timeout_ms: string;
  notify_tg_username: string;
  notify_tg_events: string;
};

export const settingsApi = {
  get: () => api.get<Settings>("/settings").then((r) => r.data),
  update: (data: Partial<Settings>) =>
    api.put<Settings>("/settings", data).then((r) => r.data),
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
  jobs: Array<{
    accountIndex: number | null;
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
  jobsImported: number;
  settingsUpdated: number;
};

export const dataApi = {
  export: () => api.get<ExportPayload>("/data/export").then((r) => r.data),
  import: (data: ExportPayload, mode: "merge" | "replace") =>
    api
      .post<ImportResult>("/data/import", { data, mode })
      .then((r) => r.data),
};
