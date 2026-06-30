<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("accounts.title") }}</h2>
      <div class="page-header-actions">
        <button v-if="accounts.length" class="btn btn-secondary" @click="toggleSelectAll">
          {{ allSelected ? t("common.deselectAll") : t("common.selectAll") }}
        </button>
        <button
          v-if="selectedIds.size > 0"
          class="btn btn-secondary"
          :disabled="spamBulkRunning"
          @click="checkSpamBulk"
        >
          <i class="fa-solid fa-user-shield"></i>
          {{ t("accounts.checkSpamSelected") }} ({{ selectedIds.size }})
        </button>
        <button
          v-if="selectedIds.size > 0"
          class="btn btn-secondary"
          @click="openExportWarn"
        >
          <i class="fa-solid fa-file-export"></i>
          {{ t("accounts.exportSelectedBtn") }} ({{ selectedIds.size }})
        </button>
        <button v-else class="btn btn-secondary" @click="openExportWarn">
          <i class="fa-solid fa-file-export"></i> {{ t("accounts.exportBtn") }}
        </button>
        <button class="btn btn-secondary" @click="openImport">
          <i class="fa-solid fa-file-import"></i> {{ t("accounts.importBtn") }}
        </button>
        <button class="btn btn-primary" @click="openAdd">
          <i class="fa-solid fa-plus"></i> {{ t("accounts.addBtn") }}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 20px"></th>
              <th>{{ t("common.name") }}</th>
              <th>{{ t("accounts.colPhone") }}</th>
              <th class="col-hide-mobile">{{ t("accounts.colTgName") }}</th>
              <th>{{ t("accounts.colStatus") }}</th>
              <th class="col-hide-mobile">{{ t("accounts.colAdded") }}</th>
              <th>{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!accounts.length">
              <td colspan="7" class="empty">{{ t("accounts.noAccounts") }}</td>
            </tr>
            <tr
              v-for="(a, idx) in accounts"
              :key="a.id"
              :class="[
                a.disabled ? 'row-disabled' : '',
                dragOverIdx === idx ? 'drag-over' : '',
                selectedIds.has(a.id) ? 'row-selected' : '',
              ]"
              style="cursor:pointer"
              draggable="true"
              @click="toggleSelect(a.id)"
              @dragstart="onDragStart(idx, $event)"
              @dragover.prevent="dragOverIdx = idx"
              @dragleave="dragOverIdx = null"
              @drop.prevent="onDrop(idx)"
              @dragend="dragOverIdx = null"
            >
              <td class="drag-handle" title="Drag to reorder">
                <i class="fa-solid fa-grip-vertical"></i>
              </td>
              <td>
                {{ a.name }}
                <span
                  v-if="a.disabled"
                  class="badge badge-grey"
                  style="margin-left: 6px; font-size: 10px"
                  >{{ t("accounts.disabled") }}</span
                >
                <span
                  v-if="a.appClientId"
                  class="badge badge-blue"
                  style="margin-left: 4px; font-size: 10px"
                  >{{
                    appClientsList.find((c) => c.id === a.appClientId)?.name ??
                    a.appClientId
                  }}</span
                >
                <span
                  v-if="a.proxyId"
                  class="badge badge-purple"
                  style="margin-left: 4px; font-size: 10px"
                  ><i
                    class="fa-solid fa-shield-halved"
                    style="margin-right: 3px"
                  ></i
                  >{{
                    proxiesList.find((p) => p.id === a.proxyId)?.name ?? "Proxy"
                  }}</span
                >
              </td>
              <td>{{ a.phoneNumber }}</td>
              <td class="col-hide-mobile">
                <div class="tg-name-cell">
                  <span v-if="metaLoading.has(a.id)" class="tg-name-loading">
                    <span class="spinner-xs"></span>
                  </span>
                  <template v-else-if="a.tgDisplayName">
                    <span class="tg-name-text">{{ a.tgDisplayName }}</span>
                    <span v-if="a.tgUsername" class="tg-name-username">@{{ a.tgUsername }}</span>
                  </template>
                  <button
                    v-if="a.authStatus === 'authenticated'"
                    class="btn btn-xs btn-ghost btn-icon tg-name-refresh"
                    :disabled="metaLoading.has(a.id)"
                    title="Refresh TG name"
                    @click.stop="fetchMeta(a.id)"
                  >
                    <i class="fa-solid fa-arrows-rotate"></i>
                  </button>
                </div>
              </td>
              <td>
                <span :class="statusBadge(a.authStatus)">{{
                  t(`accounts.status.${a.authStatus}`)
                }}</span>
                <span
                  v-if="spamCheckLoading.has(a.id)"
                  class="badge badge-grey"
                  style="margin-left: 6px"
                >
                  <i class="fa-solid fa-spinner fa-spin" style="margin-right: 3px"></i>{{ t("accounts.spamChecking") }}
                </span>
                <span
                  v-else-if="spamStatuses.get(a.id)"
                  :class="spamBadgeClass(spamStatuses.get(a.id)!.spamStatus)"
                  :title="spamStatuses.get(a.id)!.rawMessage"
                  style="margin-left: 6px; cursor: help"
                >
                  <i class="fa-solid fa-shield-halved" style="margin-right: 3px"></i>{{ t(`accounts.spam.${spamStatuses.get(a.id)!.spamStatus}`) }}
                </span>
              </td>
              <td class="col-hide-mobile">{{ fmtDate(a.createdAt) }}</td>
              <td @click.stop>
                <!-- desktop: icon buttons -->
                <div class="actions hide-mobile">
                  <button
                    v-if="a.authStatus !== 'authenticated'"
                    class="btn btn-sm btn-primary btn-icon"
                    :title="t('accounts.authenticate')"
                    @click="openAuth(a)"
                  >
                    <i class="fa-solid fa-key"></i>
                  </button>
                  <button
                    v-if="a.authStatus === 'authenticated'"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('accounts.checkStatus')"
                    @click="openCheckStatus(a)"
                  >
                    <i class="fa-solid fa-circle-info"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="a.disabled ? t('accounts.enableAccount') : t('accounts.disableAccount')"
                    @click="toggleDisabled(a)"
                  >
                    <i :class="a.disabled ? 'fa-solid fa-circle-play' : 'fa-solid fa-ban'"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('common.edit')"
                    @click="openEdit(a)"
                  >
                    <i class="fa-solid fa-pen"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-danger btn-icon"
                    :title="t('common.delete')"
                    @click="remove(a.id)"
                  >
                    <i class="fa-solid fa-trash"></i>
                  </button>
                </div>
                <!-- mobile: ... opens action sheet -->
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuAccount = a">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Export warning modal -->
    <div v-if="showExportWarn" class="modal-backdrop">
      <div class="modal" style="max-width: 460px">
        <h3 class="modal-title">
          <i
            class="fa-solid fa-triangle-exclamation"
            style="color: #f59e0b; margin-right: 8px"
          ></i
          >{{ t("accounts.exportWarnTitle") }}
        </h3>
        <div class="warn-box">{{ t("accounts.exportWarnBody") }}</div>
        <p style="font-size: 13px; color: #555; margin-top: 12px">
          {{
            selectedIds.size > 0
              ? locale === "zh"
                ? `将导出 ${selectedIds.size} 个账户`
                : `Exporting ${selectedIds.size} account(s)`
              : locale === "zh"
                ? `将导出全部 ${accounts.length} 个账户`
                : `Exporting all ${accounts.length} account(s)`
          }}
        </p>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showExportWarn = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" @click="confirmExport">
            <i class="fa-solid fa-download"></i> {{ t("common.download") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Import modal -->
    <div v-if="showImport" class="modal-backdrop">
      <div class="modal" style="max-width: 480px">
        <h3 class="modal-title">{{ t("accounts.importTitle") }}</h3>
        <div class="warn-box">{{ t("accounts.importWarnBody") }}</div>
        <div class="form-group" style="margin-top: 16px">
          <label class="form-label">{{ t("accounts.importFileLabel") }}</label>
          <input
            ref="importFileEl"
            type="file"
            accept=".json,application/json"
            class="form-input"
            @change="onImportFile"
          />
        </div>
        <div v-if="importError" class="error-msg">{{ importError }}</div>
        <div v-if="importResult" class="success-msg">{{ importResult }}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showImport = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="!importReady || importBusy"
            @click="doImport"
          >
            <i class="fa-solid fa-file-import"></i>
            {{
              importBusy ? t("accounts.importDoing") : t("accounts.importBtn")
            }}
          </button>
        </div>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal">
        <h3 class="modal-title">
          {{ t(editTarget ? "accounts.editTitle" : "accounts.addTitle") }}
        </h3>
        <div v-if="formError" class="error-msg">{{ formError }}</div>
        <div class="form-group">
          <label class="form-label">{{ t("accounts.labelName") }}</label>
          <input
            v-model.trim="form.name"
            class="form-input"
            placeholder="e.g. My Account"
          />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("accounts.labelPhone") }}</label>
          <input
            v-model.trim="form.phoneNumber"
            class="form-input"
            placeholder="+61412345678"
          />
        </div>
        <div class="form-group" style="max-width: 140px">
          <label class="form-label">{{ t("accounts.labelApiId") }}</label>
          <input v-model.trim="form.apiId" class="form-input" type="number" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("accounts.labelApiHash") }}</label>
          <input
            v-model.trim="form.apiHash"
            class="form-input"
            placeholder="32-char hex"
            style="font-family: monospace"
          />
        </div>
        <p
          style="
            font-size: 12px;
            color: #888;
            margin-top: -8px;
            margin-bottom: 14px;
          "
        >
          {{ t("accounts.apiHint") }}
          <a href="https://my.telegram.org/apps" target="_blank"
            >my.telegram.org/apps</a
          >
        </p>
        <div v-if="proxiesList.length" class="form-group">
          <label class="form-label">{{ t("accounts.labelProxy") }}</label>
          <select v-model="form.proxyId" class="form-select">
            <option value="">{{ t("accounts.proxyNone") }}</option>
            <option v-for="p in proxiesList" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("accounts.labelAppClient") }}</label>
          <select v-model="form.appClientId" class="form-select">
            <option value="">
              {{
                tgClientMode === "random"
                  ? t("accounts.appClientRandom")
                  : `${t("accounts.appClientDefault")}${defaultClientName ? ` (${defaultClientName})` : ""}`
              }}
            </option>
            <option v-for="c in appClientsList" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button
            v-if="editTarget && editTarget.authStatus !== 'unauthenticated'"
            class="btn btn-danger"
            :disabled="forceReauthBusy"
            @click="doForceReauth"
            style="margin-right: auto"
          >
            <i class="fa-solid fa-rotate-right"></i>
            {{
              forceReauthBusy ? t("common.saving") : t("accounts.forceReauth")
            }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="saving"
            @click="saveAccount"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Account status modal -->
    <div v-if="showStatus" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">
          {{ t("accounts.checkStatusTitle") }} — {{ statusTarget?.name }}
        </h3>
        <div class="modal-body">
          <div
            v-if="statusChecking"
            style="text-align: center; padding: 24px 0; color: #888"
          >
            <i class="fa-solid fa-spinner fa-spin"></i>
            {{ t("accounts.checking") }}
          </div>
          <div v-else-if="statusError" class="error-msg">{{ statusError }}</div>
          <template v-else-if="statusResult">
            <div class="status-row">
              <span class="status-label">{{ t("accounts.colStatus") }}</span>
              <span v-if="statusResult.isDeleted" class="badge badge-red">{{
                t("accounts.statusDeleted")
              }}</span>
              <span
                v-else-if="statusResult.isRestricted"
                class="badge badge-orange"
                >{{ t("accounts.statusRestricted") }}</span
              >
              <span v-else class="badge badge-green">{{
                t("accounts.statusActive")
              }}</span>
            </div>
            <div
              v-if="statusResult.firstName || statusResult.lastName"
              class="status-row"
            >
              <span class="status-label">{{
                t("accounts.statusDisplayName")
              }}</span>
              <span>{{
                [statusResult.firstName, statusResult.lastName]
                  .filter(Boolean)
                  .join(" ")
              }}</span>
            </div>
            <div v-if="statusResult.username" class="status-row">
              <span class="status-label">{{
                t("accounts.statusUsername")
              }}</span>
              <span>@{{ statusResult.username }}</span>
            </div>
            <div v-if="statusResult.phone" class="status-row">
              <span class="status-label">{{ t("accounts.statusPhone") }}</span>
              <span>+{{ statusResult.phone }}</span>
            </div>
            <div
              v-if="statusResult.restrictions.length"
              style="margin-top: 12px"
            >
              <div class="status-label" style="margin-bottom: 6px">
                {{ t("accounts.statusRestrictions") }}
              </div>
              <div
                v-for="r in statusResult.restrictions"
                :key="r.platform + r.reason"
                class="restriction-item"
              >
                <span class="badge badge-orange" style="margin-right: 6px">{{
                  r.platform
                }}</span>
                <span style="font-size: 12px; color: #555">{{
                  r.text || r.reason
                }}</span>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showStatus = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Auth modal -->
    <div v-if="showAuth" class="modal-backdrop">
      <div class="modal">
        <h3 class="modal-title">
          {{ t("accounts.authTitle") }} — {{ authTarget?.name }}
        </h3>
        <div v-if="authError" class="error-msg">{{ authError }}</div>

        <!-- Step: request code -->
        <div v-if="authStep === 'idle'">
          <p style="color: #666; margin-bottom: 16px; font-size: 13px">
            {{ t("accounts.authHint") }}
            <strong>{{ authTarget?.phoneNumber }}</strong
            >.
          </p>
          <button
            class="btn btn-primary"
            :disabled="authBusy"
            @click="sendCode"
          >
            <i class="fa-solid fa-paper-plane"></i>
            {{ authBusy ? t("accounts.sending") : t("accounts.sendCode") }}
          </button>
        </div>

        <!-- Step: enter OTP -->
        <div v-else-if="authStep === 'code'">
          <div v-if="isCodeViaApp" class="info-box" style="margin-bottom: 14px">
            <i class="fa-brands fa-telegram" style="margin-right: 6px"></i>
            {{ t("accounts.codeViaApp") }}
            <button
              class="btn btn-sm btn-ghost"
              style="margin-left: 8px"
              :disabled="resendBusy"
              @click="resendAsSms"
            >
              {{ resendBusy ? "..." : t("accounts.resendSms") }}
            </button>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelCode") }}</label>
            <input
              v-model.trim="authCode"
              class="form-input"
              placeholder="12345"
              autofocus
            />
          </div>
          <p class="code-hint-note">{{ t("accounts.codeNoReceiveHint") }}</p>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeAuth">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="authBusy"
              @click="verifyCode"
            >
              <i class="fa-solid fa-check"></i>
              {{ authBusy ? t("accounts.verifying") : t("accounts.verify") }}
            </button>
          </div>
        </div>

        <!-- Step: 2FA password -->
        <div v-else-if="authStep === '2fa'">
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelTwoFa") }}</label>
            <input
              v-model="authPassword"
              class="form-input"
              type="password"
              autofocus
            />
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeAuth">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="authBusy"
              @click="verify2fa"
            >
              <i class="fa-solid fa-check"></i>
              {{ authBusy ? t("accounts.verifying") : t("accounts.submit") }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuAccount" class="action-sheet-backdrop" @click="actionMenuAccount = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuAccount.name }}</div>
        <button
          v-if="actionMenuAccount.authStatus !== 'authenticated'"
          class="action-sheet-btn"
          @click="openAuth(actionMenuAccount); actionMenuAccount = null"
        >
          <i class="fa-solid fa-key"></i> {{ t("accounts.authenticate") }}
        </button>
        <button
          v-if="actionMenuAccount.authStatus === 'authenticated'"
          class="action-sheet-btn"
          @click="openCheckStatus(actionMenuAccount); actionMenuAccount = null"
        >
          <i class="fa-solid fa-circle-info"></i> {{ t("accounts.checkStatus") }}
        </button>
        <button
          v-if="actionMenuAccount.authStatus === 'authenticated'"
          class="action-sheet-btn"
          :disabled="metaLoading.has(actionMenuAccount.id)"
          @click="fetchMeta(actionMenuAccount.id); actionMenuAccount = null"
        >
          <i class="fa-solid fa-arrows-rotate"></i> {{ t("accounts.colTgName") }}
        </button>
        <button
          class="action-sheet-btn"
          @click="toggleDisabled(actionMenuAccount); actionMenuAccount = null"
        >
          <i :class="actionMenuAccount.disabled ? 'fa-solid fa-circle-play' : 'fa-solid fa-ban'"></i>
          {{ actionMenuAccount.disabled ? t("accounts.enableAccount") : t("accounts.disableAccount") }}
        </button>
        <button
          class="action-sheet-btn"
          @click="openEdit(actionMenuAccount); actionMenuAccount = null"
        >
          <i class="fa-solid fa-pen"></i> {{ t("common.edit") }}
        </button>
        <button
          class="action-sheet-btn danger"
          @click="remove(actionMenuAccount.id); actionMenuAccount = null"
        >
          <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuAccount = null">
          {{ t("common.cancel") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import {
  accountsApi,
  settingsApi,
  type Account,
  type Proxy,
  type TgAppClient,
  type TgAccountStatus,
  type TgSpamStatus,
  type AccountExportItem,
} from "../api/client";
import { t, locale } from "../i18n";

const accounts = ref<Account[]>([]);

// ── Drag-and-drop reorder state ───────────────────────────────────────────────
const dragSrcIdx = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

function onDragStart(idx: number, e: DragEvent) {
  dragSrcIdx.value = idx;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

async function onDrop(targetIdx: number) {
  const src = dragSrcIdx.value;
  dragSrcIdx.value = null;
  dragOverIdx.value = null;
  if (src === null || src === targetIdx) return;
  const arr = [...accounts.value];
  const [moved] = arr.splice(src, 1);
  arr.splice(targetIdx, 0, moved);
  accounts.value = arr;
  await accountsApi.reorder(arr.map((a, i) => ({ id: a.id, sortOrder: i })));
}
const settings = ref<{
  proxies?: string;
  tg_app_clients?: string;
  tg_client_mode?: string;
} | null>(null);

const proxiesList = computed<Proxy[]>(() => {
  try {
    return JSON.parse(settings.value?.proxies ?? "[]");
  } catch {
    return [];
  }
});

const appClientsList = computed<TgAppClient[]>(() => {
  try {
    return JSON.parse(settings.value?.tg_app_clients ?? "[]");
  } catch {
    return [];
  }
});

const tgClientMode = computed(
  () => settings.value?.tg_client_mode ?? "default",
);

const defaultClientName = computed(() => {
  if (tgClientMode.value === "random") return t("accounts.appClientRandom");
  return appClientsList.value.find((c) => c.isDefault)?.name ?? "";
});

// ── Form state ────────────────────────────────────────────────────────────────
const showForm = ref(false);
const editTarget = ref<Account | null>(null);
const form = reactive({
  name: "",
  phoneNumber: "",
  apiId: "",
  apiHash: "",
  proxyId: "",
  appClientId: "",
});
const formError = ref("");
const saving = ref(false);

// ── TG meta refresh (display name + username stored in DB, loaded with accounts list) ──
const metaLoading = reactive(new Set<number>());

async function fetchMeta(accountId: number) {
  if (metaLoading.has(accountId)) return;
  metaLoading.add(accountId);
  try {
    const meta = await accountsApi.refreshTgMeta(accountId);
    const idx = accounts.value.findIndex((a) => a.id === accountId);
    if (idx !== -1) {
      accounts.value[idx] = { ...accounts.value[idx], ...meta };
    }
  } catch {}
  finally { metaLoading.delete(accountId); }
}

// ── Mobile action sheet ───────────────────────────────────────────────────────
const actionMenuAccount = ref<Account | null>(null);

// ── Spam check state ──────────────────────────────────────────────────────────
const spamCheckLoading = reactive(new Set<number>());
const spamStatuses = reactive(new Map<number, TgSpamStatus>());

function spamBadgeClass(status: TgSpamStatus["spamStatus"]) {
  const map: Record<string, string> = {
    free: "badge-green",
    limited: "badge-orange",
    blocked: "badge-red",
    frozen: "badge-blue",
    unknown: "badge-grey",
  };
  return `badge ${map[status] ?? "badge-grey"}`;
}

async function checkSpam(a: Account) {
  if (spamCheckLoading.has(a.id)) return;
  spamCheckLoading.add(a.id);
  try {
    const result = await accountsApi.checkSpam(a.id);
    spamStatuses.set(a.id, result);
  } catch (err: any) {
    spamStatuses.set(a.id, {
      spamStatus: "unknown",
      rawMessage: err.response?.data?.error ?? "Check failed",
    });
  } finally {
    spamCheckLoading.delete(a.id);
  }
}

const spamBulkRunning = ref(false);

async function checkSpamBulk() {
  if (spamBulkRunning.value) return;
  const targets = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated" && !a.disabled,
  );
  if (!targets.length) return;
  spamBulkRunning.value = true;
  // Run sequentially to avoid Telegram flood limits
  for (const a of targets) {
    await checkSpam(a);
  }
  spamBulkRunning.value = false;
}

// ── Status check state ────────────────────────────────────────────────────────
const showStatus = ref(false);
const statusTarget = ref<Account | null>(null);
const statusResult = ref<TgAccountStatus | null>(null);
const statusError = ref("");
const statusChecking = ref(false);

// ── Selection state ───────────────────────────────────────────────────────────
const selectedIds = ref(new Set<number>());
const allSelected = computed(
  () =>
    accounts.value.length > 0 &&
    accounts.value.every((a) => selectedIds.value.has(a.id)),
);
const someSelected = computed(
  () =>
    accounts.value.some((a) => selectedIds.value.has(a.id)) &&
    !allSelected.value,
);

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(accounts.value.map((a) => a.id));
  }
}

function toggleSelect(id: number) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

// ── Export state ──────────────────────────────────────────────────────────────
const showExportWarn = ref(false);

function openExportWarn() {
  showExportWarn.value = true;
}

async function confirmExport() {
  showExportWarn.value = false;
  const ids = selectedIds.value.size > 0 ? [...selectedIds.value] : undefined;
  const payload = await accountsApi.export(ids);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bemby-accounts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Import state ──────────────────────────────────────────────────────────────
const showImport = ref(false);
const importFileEl = ref<HTMLInputElement | null>(null);
const importParsed = ref<AccountExportItem[] | null>(null);
const importReady = computed(() => importParsed.value !== null);
const importBusy = ref(false);
const importError = ref("");
const importResult = ref("");

function openImport() {
  importParsed.value = null;
  importError.value = "";
  importResult.value = "";
  importBusy.value = false;
  showImport.value = true;
}

function onImportFile(e: Event) {
  importError.value = "";
  importResult.value = "";
  importParsed.value = null;
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result as string);
      // Accept both a full export payload and a bare array
      const items: unknown = Array.isArray(raw) ? raw : raw?.accounts;
      if (!Array.isArray(items)) throw new Error("No accounts array found");
      importParsed.value = items as AccountExportItem[];
    } catch {
      importError.value = t("accounts.importFailed") + ": invalid JSON format";
    }
  };
  reader.readAsText(file);
}

async function doImport() {
  if (!importParsed.value) return;
  importBusy.value = true;
  importError.value = "";
  importResult.value = "";
  try {
    const { imported, skipped } = await accountsApi.import(importParsed.value);
    importResult.value =
      locale.value === "zh"
        ? `导入完成：${imported} 个成功，${skipped} 个跳过（手机号已存在）`
        : `Done: ${imported} imported, ${skipped} skipped (phone already exists)`;
    importParsed.value = null;
    if (importFileEl.value) importFileEl.value.value = "";
    await load();
  } catch (err: any) {
    importError.value =
      t("accounts.importFailed") +
      ": " +
      (err.response?.data?.error ?? err.message);
  } finally {
    importBusy.value = false;
  }
}

// ── Auth state ────────────────────────────────────────────────────────────────
const showAuth = ref(false);
const authTarget = ref<Account | null>(null);
const authStep = ref<"idle" | "code" | "2fa">("idle");
const authCode = ref("");
const authPassword = ref("");
const authError = ref("");
const authBusy = ref(false);
const isCodeViaApp = ref(false);
const resendBusy = ref(false);

// ── Lifecycle ──────────────────────────────────────────────────────────────────
onMounted(async () => {
  await load();
  // Check enabled+authenticated accounts in the background; reload if any are now expired.
  try {
    const { expired } = await accountsApi.checkEnabledSessions();
    if (expired.length > 0) await load();
  } catch {
    // Background check failure is non-critical
  }
  // Auto-fetch TG name for authenticated accounts that have none stored yet.
  for (const a of accounts.value) {
    if (a.authStatus === "authenticated" && !a.tgDisplayName) {
      fetchMeta(a.id); // fire-and-forget, shows spinner in cell
    }
  }
});

async function load() {
  [accounts.value, settings.value] = await Promise.all([
    accountsApi.list(),
    settingsApi.get(),
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusBadge(s: Account["authStatus"]) {
  const map: Record<string, string> = {
    authenticated: "badge badge-green",
    pending_code: "badge badge-orange",
    pending_2fa: "badge badge-orange",
    unauthenticated: "badge badge-grey",
    session_expired: "badge badge-red",
  };
  return map[s] ?? "badge badge-grey";
}

function fmtDate(iso: string) {
  const localeMap: Record<string, string> = { en: "en-AU", zh: "zh-CN" };
  return new Date(iso).toLocaleDateString(localeMap[locale.value] ?? "en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ── Add / Edit ─────────────────────────────────────────────────────────────────
function openAdd() {
  editTarget.value = null;
  Object.assign(form, {
    name: "",
    phoneNumber: "",
    apiId: "",
    apiHash: "",
    proxyId: "",
    appClientId: "",
  });
  formError.value = "";
  showForm.value = true;
}

function openEdit(a: Account) {
  editTarget.value = a;
  Object.assign(form, {
    name: a.name,
    phoneNumber: a.phoneNumber,
    apiId: String(a.apiId),
    apiHash: "",
    proxyId: a.proxyId ?? "",
    appClientId: a.appClientId ?? "",
  });
  formError.value = "";
  showForm.value = true;
}

async function saveAccount() {
  formError.value = "";
  saving.value = true;
  try {
    if (editTarget.value) {
      await accountsApi.update(editTarget.value.id, {
        name: form.name,
        phoneNumber: form.phoneNumber,
        apiId: Number(form.apiId),
        ...(form.apiHash ? { apiHash: form.apiHash } : {}),
        proxyId: form.proxyId || null,
        appClientId: form.appClientId || null,
      });
    } else {
      await accountsApi.create({
        name: form.name,
        phoneNumber: form.phoneNumber,
        apiId: Number(form.apiId),
        apiHash: form.apiHash,
        proxyId: form.proxyId || null,
        appClientId: form.appClientId || null,
      });
    }
    showForm.value = false;
    await load();
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t("common.saveFailed");
  } finally {
    saving.value = false;
  }
}

// ── Force Re-auth ─────────────────────────────────────────────────────────────
const forceReauthBusy = ref(false);

async function doForceReauth() {
  if (!editTarget.value) return;
  const msg =
    locale.value === "zh"
      ? "这将清除该账户的会话，您需要重新进行身份验证。确定吗？"
      : "This will clear the session for this account and require re-authentication. Continue?";
  if (!confirm(msg)) return;
  forceReauthBusy.value = true;
  try {
    await accountsApi.forceReauth(editTarget.value.id);
    showForm.value = false;
    await load();
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t("common.saveFailed");
  } finally {
    forceReauthBusy.value = false;
  }
}

async function remove(id: number) {
  if (!confirm(t("accounts.confirmDelete"))) return;
  await accountsApi.delete(id);
  await load();
}

async function toggleDisabled(a: Account) {
  await accountsApi.update(a.id, { disabled: !a.disabled });
  await load();
}

async function openCheckStatus(a: Account) {
  statusTarget.value = a;
  statusResult.value = null;
  statusError.value = "";
  statusChecking.value = true;
  showStatus.value = true;
  try {
    statusResult.value = await accountsApi.checkStatus(a.id);
  } catch (err: any) {
    statusError.value = err.response?.data?.error ?? "Failed to check status";
  } finally {
    statusChecking.value = false;
  }
  // Run spam check after checkStatus disconnects to avoid AUTH_KEY_DUPLICATED
  // (both calls create separate TelegramClient instances from the same session)
  if (!a.disabled) checkSpam(a);
}

// ── Auth flow ─────────────────────────────────────────────────────────────────
function openAuth(a: Account) {
  authTarget.value = a;
  authStep.value = "idle";
  authCode.value = "";
  authPassword.value = "";
  authError.value = "";
  showAuth.value = true;
}

function closeAuth() {
  showAuth.value = false;
}

async function sendCode() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    const res = await accountsApi.requestCode(authTarget.value.id);
    isCodeViaApp.value = res.isCodeViaApp;
    authStep.value = "code";
  } catch (err: any) {
    authError.value =
      err.response?.data?.error ?? t("accounts.errors.sendFailed");
  } finally {
    authBusy.value = false;
  }
}

async function resendAsSms() {
  if (!authTarget.value) return;
  resendBusy.value = true;
  try {
    await accountsApi.resendCode(authTarget.value.id);
    isCodeViaApp.value = false;
  } catch (err: any) {
    authError.value =
      err.response?.data?.error ?? t("accounts.errors.sendFailed");
  } finally {
    resendBusy.value = false;
  }
}

async function verifyCode() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    const res = await accountsApi.verify(authTarget.value.id, {
      code: authCode.value,
    });
    if (res.step === "2fa") {
      authStep.value = "2fa";
    } else {
      showAuth.value = false;
      await load();
    }
  } catch (err: any) {
    authError.value =
      err.response?.data?.error ?? t("accounts.errors.verifyFailed");
  } finally {
    authBusy.value = false;
  }
}

async function verify2fa() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    await accountsApi.verify(authTarget.value.id, {
      password: authPassword.value,
    });
    showAuth.value = false;
    await load();
  } catch (err: any) {
    authError.value =
      err.response?.data?.error ?? t("accounts.errors.twoFaFailed");
  } finally {
    authBusy.value = false;
  }
}
</script>

<style scoped>
.tg-name-cell {
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tg-name-text {
  font-size: 13px;
}

.tg-name-username {
  font-size: 11px;
  color: #888;
}

.tg-name-loading {
  display: flex;
  align-items: center;
}

.tg-name-refresh {
  opacity: 0;
  transition: opacity 0.15s;
  padding: 2px 4px;
  font-size: 11px;
}

tr:hover .tg-name-refresh {
  opacity: 1;
}

@media (max-width: 767px) {
  .tg-name-cell {
    display: none;
  }
}

.btn-xs {
  padding: 2px 6px;
  font-size: 11px;
  height: 22px;
}

/* Minimal inline spinner */
.spinner-xs {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid #e5e7eb;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.page-header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.code-hint-note {
  font-size: 12px;
  color: #9ca3af;
  margin: 6px 0 12px;
  line-height: 1.5;
}

.warn-box {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
  color: #92400e;
  line-height: 1.5;
}

.row-disabled td {
  opacity: 0.5;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}

.status-label {
  min-width: 110px;
  font-weight: 500;
  color: #666;
  flex-shrink: 0;
}

.restriction-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px solid #f5f5f5;
}

.drag-handle {
  cursor: grab;
  color: #ccc;
  padding: 0 4px;
  user-select: none;
  width: 20px;
}

.drag-handle:hover {
  color: #888;
}

tr[draggable] {
  cursor: default;
}

tr.drag-over td {
  background: #eef2ff;
}

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
}

.action-sheet-header {
  padding: 14px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  border-bottom: 1px solid #f0f0f0;
}

.action-sheet-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 15px 20px;
  background: none;
  border: none;
  font-size: 15px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: #f5f5f5;
}

.action-sheet-btn.danger {
  color: #e63946;
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}
</style>
