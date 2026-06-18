export type AuthStatus = 'unauthenticated' | 'pending_code' | 'pending_2fa' | 'authenticated';
export type JobType = 'checkin' | 'embywatch' | 'custom';
export type LogStatus = 'success' | 'failed' | 'running';

export type TgAccount = {
  id: number;
  name: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString: string | null;
  authStatus: AuthStatus;
  createdAt: string;
};

export type Job = {
  id: number;
  name: string;
  /** null for embywatch jobs that don't require a Telegram account */
  accountId: number | null;
  jobType: JobType;
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

export type CustomAction =
  | { type: 'send_command'; content: string; maxRetries?: number }
  | { type: 'wait_reply'; maxWaitMs: number; successContains?: string; failContains?: string; maxRetries?: number }
  | { type: 'delay'; waitMs: number }
  | { type: 'click_button'; button: string; maxRetries: number; maxWaitMs: number }
  | { type: 'enter_captcha'; maxWaitMs: number; captchaLength?: number; maxRetries?: number };

export type CustomConfig = {
  actions: CustomAction[];
  maxRetries?: number;
};

export type CustomStepLog = {
  step: number;
  actionType: string;
  label: string;
  /** For click_button: the bot message we clicked on, when we had to wait for it */
  preClickHtml?: string;
  preClickImage?: string;
  preClickButtons?: string[][];
  preClickHasMedia?: boolean;
  clickedButton?: string;
  /** Bot response after the action */
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
  /** For wait_reply: number of messages received during the wait */
  msgCount?: number;
  /** For click_button: 'edit' or 'new_message' — which response path fired */
  responseSource?: 'edit' | 'new_message';
  /** For click_button: how many retries were needed (0 = first attempt succeeded) */
  retryCount?: number;
  errorName?: string;
  /** Which job-level attempt this step belongs to, 1-based (only set when job maxRetries > 1) */
  jobAttempt?: number;
  /** Which action-level attempt this is, 1-based (only set when action maxRetries > 0) */
  actionAttempt?: number;
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  /** Mark the episode as watched after playback completes. Defaults to true. */
  markWatched?: boolean;
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

export type JobLog = {
  id: number;
  jobId: number;
  jobName: string | null;
  accountName: string | null;
  ranAt: string;
  status: LogStatus;
  message: string | null;
};
