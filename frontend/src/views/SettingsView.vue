<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("settings.title") }}</h2>
    </div>

    <div class="settings-grid">
      <!-- System defaults -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.sysDefaults") }}</div>

          <div v-if="saveMsg" class="success-msg">{{ saveMsg }}</div>
          <div v-if="saveError" class="error-msg">{{ saveError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelTimezone")
              }}</label>
              <select v-model="form.default_timezone" class="form-select">
                <option v-for="tz in timezones" :key="tz" :value="tz">
                  {{ tz }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelMaxRetries")
              }}</label>
              <input
                v-model.number="form.default_max_retry"
                class="form-input"
                type="number"
                min="1"
                max="10"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input v-model="form.check_daily_run" type="checkbox" />
              <span>{{ t("settings.labelDailyRun") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.dailyRunHint") }}
            </p>
          </div>

          <button
            class="btn btn-primary"
            :disabled="saving"
            @click="saveSettings"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ saving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- TG Notifications -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.notifySection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.notifyHint") }}
          </p>

          <div v-if="notifyMsg" class="success-msg">{{ notifyMsg }}</div>
          <div v-if="notifyError" class="error-msg">{{ notifyError }}</div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyUsername")
            }}</label>
            <input
              v-model.trim="notifyForm.username"
              class="form-input"
              :placeholder="t('settings.notifyUsernamePlaceholder')"
            />
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyEvents")
            }}</label>
            <div class="event-pills">
              <label
                v-for="ev in notifyEventOptions"
                :key="ev.value"
                class="event-pill"
                :class="{ active: notifyForm.events.includes(ev.value) }"
              >
                <input
                  type="checkbox"
                  :checked="notifyForm.events.includes(ev.value)"
                  @change="toggleNotifyEvent(ev.value)"
                />
                {{ ev.label }}
              </label>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="notifySaving"
            @click="saveNotify"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ notifySaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Admin credentials -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.adminCreds") }}</div>

          <div v-if="credMsg" class="success-msg">{{ credMsg }}</div>
          <div v-if="credError" class="error-msg">{{ credError }}</div>

          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewUsername") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model.trim="cred.username"
              class="form-input"
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewPassword") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model="cred.newPassword"
              class="form-input"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="form-group">
            <label class="form-label"
              >{{ t("settings.labelCurrentPass") }}
              <span style="color: #e63946">*</span></label
            >
            <input
              v-model="cred.currentPassword"
              class="form-input"
              type="password"
              autocomplete="current-password"
            />
          </div>

          <button
            class="btn btn-primary"
            :disabled="credSaving"
            @click="saveCredentials"
          >
            <i class="fa-solid fa-shield-halved"></i>
            {{ credSaving ? t("common.saving") : t("settings.updateBtn") }}
          </button>
        </div>
      </div>

      <!-- Emby defaults -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.embyDefaults") }}</div>

          <div v-if="embyMsg" class="success-msg">{{ embyMsg }}</div>
          <div v-if="embyError" class="error-msg">{{ embyError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelPlayDuration")
              }}</label>
              <input
                v-model.number="form.default_play_duration"
                class="form-input"
                type="number"
                min="30"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDeviceName")
              }}</label>
              <input
                v-model.trim="form.default_device_name"
                class="form-input"
                placeholder="Mac"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.labelUserAgent") }}</label>
            <select v-model="form.default_ua" class="form-select">
              <option value="">— {{ t("jobs.uaDefault") }} —</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.value">
                {{ p.name }}
              </option>
            </select>
          </div>

          <div style="margin-bottom: 16px">
            <div class="card-section-title" style="margin-bottom: 10px">
              {{ t("settings.uaPresetsSection") }}
            </div>
            <div v-for="(p, i) in uaPresets" :key="i" class="ua-preset-row">
              <span class="ua-preset-name">{{ p.name }}</span>
              <span class="ua-preset-value">{{ p.value }}</span>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.uaPresetDeleteTip')"
                @click="removeUaPreset(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div class="ua-preset-add">
              <input
                v-model.trim="newPresetName"
                class="form-input"
                style="flex: 0 0 140px"
                :placeholder="t('settings.uaPresetName')"
                @keyup.enter="addUaPreset"
              />
              <input
                v-model.trim="newPresetValue"
                class="form-input"
                style="flex: 1; min-width: 0"
                :placeholder="t('settings.uaPresetValue')"
                @keyup.enter="addUaPreset"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newPresetName || !newPresetValue"
                @click="addUaPreset"
              >
                <i class="fa-solid fa-plus"></i> {{ t("settings.addPreset") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="embySaving"
            @click="saveEmby"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ embySaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Proxies -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.proxiesSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.proxiesHint") }}
          </p>

          <div v-if="proxiesMsg" class="success-msg">{{ proxiesMsg }}</div>
          <div v-if="proxiesError" class="error-msg">{{ proxiesError }}</div>

          <div v-for="(p, i) in proxies" :key="p.id">
            <div v-if="editingProxyId === p.id" class="proxy-edit-panel">
              <div class="proxy-row">
                <select
                  v-model="editProxyForm.protocol"
                  class="form-select"
                  style="flex: 0 0 110px"
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                </select>
                <input
                  v-model.trim="editProxyForm.host"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyHost')"
                  @input="onProxyHostInput(editProxyForm)"
                />
                <input
                  v-model.trim="editProxyForm.port"
                  class="form-input"
                  style="flex: 0 0 80px"
                  type="number"
                  min="1"
                  max="65535"
                  :placeholder="t('settings.proxyPort')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editProxyForm.username"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyUsername')"
                  autocomplete="off"
                />
                <input
                  v-model.trim="editProxyForm.password"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyPassword')"
                  autocomplete="off"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editProxyForm.name"
                  class="form-input"
                  style="flex: 0 0 160px"
                  :placeholder="t('settings.proxyName')"
                />
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="
                    proxyEditTesting ||
                    !editProxyForm.name ||
                    !editProxyForm.host
                  "
                  @click="saveProxyEdit(i)"
                >
                  {{
                    proxyEditTesting
                      ? t("settings.proxyTesting")
                      : t("common.save")
                  }}
                </button>
                <button
                  class="btn btn-sm btn-ghost"
                  @click="editingProxyId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <div v-else class="ua-preset-row">
              <span class="ua-preset-name">{{ p.name }}</span>
              <span class="ua-preset-value">{{ p.url }}</span>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="startEditProxy(p)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.proxyDeleteTip')"
                @click="removeProxy(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          <div class="proxy-edit-panel" style="margin-top: 8px">
            <div class="proxy-row">
              <select
                v-model="newProxy.protocol"
                class="form-select"
                style="flex: 0 0 110px"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
              </select>
              <input
                v-model.trim="newProxy.host"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyHost')"
                @input="onProxyHostInput(newProxy)"
              />
              <input
                v-model.trim="newProxy.port"
                class="form-input"
                style="flex: 0 0 80px"
                type="number"
                min="1"
                max="65535"
                :placeholder="t('settings.proxyPort')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.username"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyUsername')"
                autocomplete="off"
              />
              <input
                v-model.trim="newProxy.password"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyPassword')"
                autocomplete="off"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.name"
                class="form-input"
                style="flex: 0 0 160px"
                :placeholder="t('settings.proxyName')"
                @keyup.enter="addProxy"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newProxy.name || !newProxy.host || proxyTesting"
                @click="addProxy"
              >
                <i class="fa-solid fa-plus"></i>
                {{
                  proxyTesting
                    ? t("settings.proxyTesting")
                    : t("settings.addProxy")
                }}
              </button>
            </div>
          </div>
          <p style="font-size: 11px; color: #888; margin: 4px 0 0">
            {{ t("settings.proxyUrlHint") }}
          </p>

          <button
            class="btn btn-primary"
            style="margin-top: 14px"
            :disabled="proxiesSaving"
            @click="saveProxies"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ proxiesSaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- TG App Clients -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.appClientsSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.appClientsHint") }}
          </p>

          <div v-if="appClientsMsg" class="success-msg">
            {{ appClientsMsg }}
          </div>
          <div v-if="appClientsError" class="error-msg">
            {{ appClientsError }}
          </div>

          <div class="tg-client-mode-row">
            <span class="form-label" style="margin: 0">{{
              t("settings.tgClientModeLabel")
            }}</span>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="default" />
              {{ t("settings.tgClientModeDefault") }}
            </label>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="random" />
              {{ t("settings.tgClientModeRandom") }}
            </label>
          </div>

          <div v-for="(c, i) in appClients" :key="c.id">
            <div v-if="editingClientId === c.id" class="proxy-edit-panel">
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.name"
                  class="form-input"
                  style="flex: 0 0 110px"
                  :placeholder="t('settings.appClientName')"
                />
                <input
                  v-model.trim="editClientForm.deviceModel"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientDevice')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.systemVersion"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientSystem')"
                />
                <input
                  v-model.trim="editClientForm.appVersion"
                  class="form-input"
                  style="flex: 0 0 120px"
                  :placeholder="t('settings.appClientApp')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.langCode"
                  class="form-input"
                  style="flex: 0 0 80px"
                  :placeholder="t('settings.appClientLangCode')"
                />
                <input
                  v-model.trim="editClientForm.langPack"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientLangPack')"
                />
                <input
                  v-model.trim="editClientForm.systemLangCode"
                  class="form-input"
                  style="flex: 0 0 100px"
                  :placeholder="t('settings.appClientSysLang')"
                />
              </div>
              <div class="proxy-row">
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="
                    !editClientForm.name || !editClientForm.deviceModel
                  "
                  @click="saveClientEdit(i)"
                >
                  {{ t("common.save") }}
                </button>
                <button
                  class="btn btn-sm btn-ghost"
                  @click="editingClientId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <div v-else class="ua-preset-row">
              <span class="ua-preset-name">{{ c.name }}</span>
              <span class="ua-preset-value"
                >{{ c.deviceModel }} / {{ c.systemVersion }}</span
              >
              <template v-if="tgClientMode !== 'random'">
                <span
                  v-if="c.isDefault"
                  class="badge badge-green"
                  style="font-size: 11px; padding: 1px 6px"
                  >{{ t("settings.appClientIsDefault") }}</span
                >
                <button
                  v-else
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('settings.appClientSetDefault')"
                  @click="setDefaultClient(i)"
                >
                  <i class="fa-regular fa-star"></i>
                </button>
              </template>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="startEditClient(c)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.appClientDeleteTip')"
                :disabled="tgClientMode !== 'random' && c.isDefault"
                @click="removeClient(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          <!-- Add new client form -->
          <div class="proxy-edit-panel" style="margin-top: 8px">
            <div class="proxy-row">
              <input
                v-model.trim="newClient.name"
                class="form-input"
                style="flex: 0 0 110px"
                :placeholder="t('settings.appClientName')"
              />
              <input
                v-model.trim="newClient.deviceModel"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientDevice')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.systemVersion"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientSystem')"
              />
              <input
                v-model.trim="newClient.appVersion"
                class="form-input"
                style="flex: 0 0 120px"
                :placeholder="t('settings.appClientApp')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.langCode"
                class="form-input"
                style="flex: 0 0 80px"
                :placeholder="t('settings.appClientLangCode')"
              />
              <input
                v-model.trim="newClient.langPack"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientLangPack')"
              />
              <input
                v-model.trim="newClient.systemLangCode"
                class="form-input"
                style="flex: 0 0 100px"
                :placeholder="t('settings.appClientSysLang')"
              />
            </div>
            <div class="proxy-row">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newClient.name || !newClient.deviceModel"
                @click="addClient"
              >
                <i class="fa-solid fa-plus"></i>
                {{ t("settings.addAppClient") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            style="margin-top: 14px"
            :disabled="appClientsSaving"
            @click="saveAppClients"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ appClientsSaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Import / Export -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.importExport.title") }}
          </div>

          <div v-if="importMsg" class="success-msg">{{ importMsg }}</div>
          <div v-if="importError" class="error-msg">{{ importError }}</div>

          <div class="form-group">
            <p style="font-size: 12px; color: #888; margin: 0 0 8px">
              {{ t("settings.importExport.exportHint") }}
            </p>
            <button class="btn btn-secondary" @click="doExport">
              <i class="fa-solid fa-file-export"></i>
              {{ t("settings.importExport.exportBtn") }}
            </button>
          </div>

          <hr class="ie-divider" />

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importLabel")
            }}</label>
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              class="form-input"
              @change="onFileChange"
            />
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importMode")
            }}</label>
            <div class="import-mode-row">
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="merge" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeMerge") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeMergeHint") }}
                  </div>
                </div>
              </label>
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="replace" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeReplace") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeReplaceHint") }}
                  </div>
                </div>
              </label>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="importing"
            @click="doImport"
          >
            <i class="fa-solid fa-file-import"></i>
            {{
              importing
                ? t("settings.importExport.importing")
                : t("settings.importExport.importBtn")
            }}
          </button>
        </div>
      </div>

      <!-- AI button detection -->
      <div class="card s-col-12">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.aiSection") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 16px">
            {{ t("settings.aiHint") }}
          </p>

          <!-- Providers list -->
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-bottom: 10px;
            "
          >
            <div class="card-section-title" style="margin: 0">
              {{ t("settings.aiProvidersSection") }}
            </div>
            <button
              class="btn btn-ghost btn-sm"
              @click="showAddSupplier = true"
            >
              <i class="fa-solid fa-plus"></i> {{ t("settings.addProvider") }}
            </button>
          </div>

          <div v-if="aiSuppliersLoading" style="color: #888; font-size: 13px">
            {{ t("common.loading") }}
          </div>
          <div
            v-else-if="!suppliers.length"
            style="color: #aaa; font-size: 13px; margin-bottom: 12px"
          >
            {{ t("settings.noSuppliers") }}
          </div>

          <div v-for="s in suppliers" :key="s.id" class="supplier-card">
            <!-- Supplier header -->
            <div v-if="editingSupplierId !== s.id" class="supplier-header">
              <div class="supplier-info">
                <span class="supplier-name">{{ s.name }}</span>
                <span class="supplier-url">{{ s.base_url }}</span>
                <span class="supplier-timeout">{{ s.timeout_ms }}ms</span>
              </div>
              <div class="supplier-actions">
                <button
                  class="btn btn-ghost btn-sm"
                  @click="startEditSupplier(s)"
                >
                  {{ t("settings.editSupplier") }}
                </button>
                <button
                  class="btn btn-ghost btn-sm btn-danger"
                  @click="removeSupplier(s.id)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
            <div
              v-if="editingSupplierId !== s.id && !s.api_key"
              class="supplier-no-key-warning"
            >
              <i class="fa-solid fa-triangle-exclamation"></i>
              {{ t("settings.supplierNoApiKey") }}
            </div>

            <!-- Supplier edit form -->
            <div v-if="editingSupplierId === s.id" class="supplier-edit-form">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierName")
                  }}</label>
                  <input v-model.trim="editForm.name" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierTimeout")
                  }}</label>
                  <input
                    v-model.number="editForm.timeout_ms"
                    class="form-input"
                    type="number"
                    min="1000"
                    step="1000"
                  />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierBaseUrl")
                }}</label>
                <input
                  v-model.trim="editForm.base_url"
                  class="form-input"
                  placeholder="https://openrouter.ai/api/v1"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierApiKey")
                }}</label>
                <input
                  v-model.trim="editForm.api_key"
                  class="form-input"
                  type="text"
                  autocomplete="off"
                  placeholder="sk-..."
                />
              </div>
              <div style="display: flex; gap: 8px">
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="supplierSaving"
                  @click="saveEditSupplier(s.id)"
                >
                  {{
                    supplierSaving
                      ? t("common.saving")
                      : t("settings.saveSupplier")
                  }}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  @click="editingSupplierId = null"
                >
                  {{ t("settings.cancelEdit") }}
                </button>
              </div>
            </div>

            <!-- Models -->
            <div class="supplier-models">
              <div class="supplier-models-label">
                {{ t("settings.supplierModels") }}
              </div>
              <div class="supplier-model-chips">
                <span v-for="m in s.models" :key="m.id" class="model-chip">
                  {{ m.model_id }}
                  <button
                    class="model-chip-del"
                    @click="removeModel(s.id, m.id)"
                  >
                    <i class="fa-solid fa-xmark"></i>
                  </button>
                </span>
                <span
                  v-if="!s.models.length"
                  style="color: #aaa; font-size: 12px"
                  >—</span
                >
              </div>
              <div class="model-add-row">
                <input
                  v-model.trim="newModelInputs[s.id]"
                  class="form-input form-input-sm"
                  :placeholder="t('settings.modelId')"
                  @keyup.enter="addModel(s.id)"
                />
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!newModelInputs[s.id]"
                  @click="addModel(s.id)"
                >
                  <i class="fa-solid fa-plus"></i> {{ t("settings.addModel") }}
                </button>
              </div>
            </div>
          </div>

          <!-- Add supplier form -->
          <div v-if="showAddSupplier" class="supplier-card supplier-edit-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierName")
                }}</label>
                <input
                  v-model.trim="newSupplierForm.name"
                  class="form-input"
                  placeholder="OpenRouter"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierTimeout")
                }}</label>
                <input
                  v-model.number="newSupplierForm.timeout_ms"
                  class="form-input"
                  type="number"
                  min="1000"
                  step="1000"
                />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierBaseUrl")
              }}</label>
              <input
                v-model.trim="newSupplierForm.base_url"
                class="form-input"
                placeholder="https://openrouter.ai/api/v1"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierApiKey")
              }}</label>
              <input
                v-model.trim="newSupplierForm.api_key"
                class="form-input"
                type="text"
                autocomplete="off"
                placeholder="sk-..."
              />
            </div>
            <div style="display: flex; gap: 8px">
              <button
                class="btn btn-primary btn-sm"
                :disabled="
                  supplierSaving ||
                  !newSupplierForm.name ||
                  !newSupplierForm.base_url
                "
                @click="createSupplier"
              >
                {{
                  supplierSaving
                    ? t("common.saving")
                    : t("settings.saveSupplier")
                }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                @click="showAddSupplier = false"
              >
                {{ t("settings.cancelEdit") }}
              </button>
            </div>
          </div>

          <div v-if="supplierError" class="error-msg" style="margin-top: 8px">
            {{ supplierError }}
          </div>

          <!-- Default model -->
          <div
            style="
              margin-top: 20px;
              padding-top: 16px;
              border-top: 1px solid #e5e7eb;
            "
          >
            <div class="form-group">
              <label class="form-label">{{ t("settings.defaultModel") }}</label>
              <select v-model="form.ai_model" class="form-select">
                <option value="">{{ t("settings.defaultModelNone") }}</option>
                <optgroup v-for="s in suppliers" :key="s.id" :label="s.name">
                  <option v-for="m in s.models" :key="m.id" :value="m.model_id">
                    {{ m.model_id }}
                  </option>
                </optgroup>
              </select>
            </div>
            <div v-if="aiMsg" class="success-msg">{{ aiMsg }}</div>
            <div v-if="aiError" class="error-msg">{{ aiError }}</div>
            <button
              class="btn btn-primary"
              :disabled="aiSaving"
              @click="saveAi"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{
                aiSaving ? t("common.saving") : t("settings.saveDefaultModel")
              }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { settingsApi, authApi, dataApi, aiSuppliersApi } from "../api/client";
import type {
  ExportPayload,
  UAPreset,
  AiSupplier,
  Proxy,
  TgAppClient,
} from "../api/client";
import { t } from "../i18n";

const timezones = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Darwin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "UTC",
];

const form = reactive({
  default_timezone: "Australia/Sydney",
  default_max_retry: 5,
  check_daily_run: true,
  default_ua: "",
  default_play_duration: 300,
  default_device_name: "Mac",
  ai_model: "",
});
const saving = ref(false);
const saveMsg = ref("");
const saveError = ref("");

const embySaving = ref(false);
const embyMsg = ref("");
const embyError = ref("");

const aiSaving = ref(false);
const aiMsg = ref("");
const aiError = ref("");

const suppliers = ref<AiSupplier[]>([]);
const aiSuppliersLoading = ref(false);
const editingSupplierId = ref<number | null>(null);
const editForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const newSupplierForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const showAddSupplier = ref(false);
const supplierSaving = ref(false);
const supplierError = ref("");
const newModelInputs = ref<Record<number, string>>({});

const notifyForm = reactive({ username: "", events: ["failed"] as string[] });
const notifySaving = ref(false);
const notifyMsg = ref("");
const notifyError = ref("");

const uaPresets = ref<UAPreset[]>([]);
const newPresetName = ref("");
const newPresetValue = ref("");

const proxies = ref<Proxy[]>([]);
const proxiesSaving = ref(false);
const proxyTesting = ref(false);
const editingProxyId = ref<string | null>(null);
const proxyEditTesting = ref(false);
const proxiesMsg = ref("");
const proxiesError = ref("");

type ProxyForm = {
  protocol: "socks5" | "socks4";
  host: string;
  port: string;
  username: string;
  password: string;
  name: string;
};
const newProxy = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});
const editProxyForm = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});

function buildProxyUrl(f: ProxyForm): string {
  const auth = f.username
    ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@`
    : "";
  return `${f.protocol}://${auth}${f.host}:${f.port || "1080"}`;
}

function parseProxyInput(raw: string): Omit<ProxyForm, "name"> | null {
  try {
    const normalized = /^socks[45]?:\/\//i.test(raw) ? raw : `socks5://${raw}`;
    const u = new URL(normalized);
    const proto = u.protocol.replace(":", "").toLowerCase();
    return {
      protocol: proto === "socks4" ? "socks4" : "socks5",
      host: u.hostname,
      port: u.port || "1080",
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

function onProxyHostInput(form: ProxyForm) {
  const val = form.host;
  if (val.includes("://") || val.includes("@")) {
    const parsed = parseProxyInput(val);
    if (parsed) Object.assign(form, parsed);
  }
}

// ── TG App Clients ─────────────────────────────────────────────────────────────

const appClients = ref<TgAppClient[]>([]);
const tgClientMode = ref<"default" | "random">("default");
const appClientsSaving = ref(false);
const editingClientId = ref<string | null>(null);
const appClientsMsg = ref("");
const appClientsError = ref("");

type AppClientForm = {
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
};
const newClient = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});
const editClientForm = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});

function addClient() {
  if (!newClient.name.trim() || !newClient.deviceModel.trim()) return;
  appClients.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newClient.name.trim(),
    deviceModel: newClient.deviceModel.trim(),
    systemVersion: newClient.systemVersion.trim(),
    appVersion: newClient.appVersion.trim(),
    langCode: newClient.langCode.trim() || "en",
    langPack: newClient.langPack.trim(),
    systemLangCode: newClient.systemLangCode.trim() || "en-US",
    isDefault: false,
  });
  Object.assign(newClient, {
    name: "",
    deviceModel: "",
    systemVersion: "",
    appVersion: "",
    langCode: "en",
    langPack: "",
    systemLangCode: "en-US",
  });
}

function removeClient(index: number) {
  appClients.value.splice(index, 1);
}

function startEditClient(c: TgAppClient) {
  editingClientId.value = c.id;
  Object.assign(editClientForm, {
    name: c.name,
    deviceModel: c.deviceModel,
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  });
}

function saveClientEdit(index: number) {
  if (!editClientForm.name.trim() || !editClientForm.deviceModel.trim()) return;
  const existing = appClients.value[index];
  appClients.value[index] = {
    ...existing,
    name: editClientForm.name.trim(),
    deviceModel: editClientForm.deviceModel.trim(),
    systemVersion: editClientForm.systemVersion.trim(),
    appVersion: editClientForm.appVersion.trim(),
    langCode: editClientForm.langCode.trim() || "en",
    langPack: editClientForm.langPack.trim(),
    systemLangCode: editClientForm.systemLangCode.trim() || "en-US",
  };
  editingClientId.value = null;
}

function setDefaultClient(index: number) {
  appClients.value = appClients.value.map((c, i) => ({
    ...c,
    isDefault: i === index,
  }));
}

async function saveAppClients() {
  appClientsMsg.value = "";
  appClientsError.value = "";
  appClientsSaving.value = true;
  try {
    await settingsApi.update({
      tg_app_clients: JSON.stringify(appClients.value),
      tg_client_mode: tgClientMode.value,
    });
    appClientsMsg.value = t("settings.saved");
  } catch (err: any) {
    appClientsError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    appClientsSaving.value = false;
  }
}

const notifyEventOptions = computed(() => [
  { value: "failed", label: t("settings.notifyEventFailed") },
  { value: "success", label: t("settings.notifyEventSuccess") },
]);

function toggleNotifyEvent(value: string) {
  const idx = notifyForm.events.indexOf(value);
  if (idx === -1) notifyForm.events.push(value);
  else notifyForm.events.splice(idx, 1);
}

const cred = reactive({ username: "", newPassword: "", currentPassword: "" });
const credSaving = ref(false);
const credMsg = ref("");
const credError = ref("");

onMounted(async () => {
  try {
    const s = await settingsApi.get();
    form.default_timezone = s.default_timezone;
    form.default_max_retry = Number(s.default_max_retry);
    form.check_daily_run = s.check_daily_run !== "false";
    form.default_ua = s.default_ua ?? "";
    try {
      uaPresets.value = JSON.parse(s.ua_presets ?? "[]");
    } catch {
      uaPresets.value = [];
    }
    try {
      proxies.value = JSON.parse(s.proxies ?? "[]");
    } catch {
      proxies.value = [];
    }
    try {
      appClients.value = JSON.parse(s.tg_app_clients ?? "[]");
    } catch {
      appClients.value = [];
    }
    tgClientMode.value = s.tg_client_mode === "random" ? "random" : "default";
    form.default_play_duration = Number(s.default_play_duration ?? 300);
    form.default_device_name = s.default_device_name ?? "Mac";
    form.ai_model = s.ai_model ?? "";
    notifyForm.username = s.notify_tg_username ?? "";
    try {
      if (s.notify_tg_events)
        notifyForm.events = JSON.parse(s.notify_tg_events);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  try {
    aiSuppliersLoading.value = true;
    suppliers.value = await aiSuppliersApi.list();
  } catch {
    /* ignore */
  } finally {
    aiSuppliersLoading.value = false;
  }
});

async function saveSettings() {
  saveMsg.value = "";
  saveError.value = "";
  saving.value = true;
  try {
    await settingsApi.update({
      default_timezone: form.default_timezone,
      default_max_retry: String(form.default_max_retry),
      check_daily_run: String(form.check_daily_run),
    });
    saveMsg.value = t("settings.saved");
  } catch (err: any) {
    saveError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    saving.value = false;
  }
}

function addUaPreset() {
  const name = newPresetName.value.trim();
  const value = newPresetValue.value.trim();
  if (!name || !value) return;
  uaPresets.value.push({ name, value });
  newPresetName.value = "";
  newPresetValue.value = "";
}

function removeUaPreset(index: number) {
  // If the default UA matches the removed preset, clear it
  if (form.default_ua === uaPresets.value[index]?.value) form.default_ua = "";
  uaPresets.value.splice(index, 1);
}

async function addProxy() {
  if (!newProxy.name.trim() || !newProxy.host.trim()) return;
  const url = buildProxyUrl(newProxy);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyTesting.value = false;
  }

  proxies.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newProxy.name.trim(),
    url,
  });
  Object.assign(newProxy, {
    protocol: "socks5",
    host: "",
    port: "1080",
    username: "",
    password: "",
    name: "",
  });
}

function removeProxy(index: number) {
  proxies.value.splice(index, 1);
}

function startEditProxy(p: Proxy) {
  editingProxyId.value = p.id;
  const parsed = parseProxyInput(p.url);
  Object.assign(editProxyForm, {
    protocol: parsed?.protocol ?? "socks5",
    host: parsed?.host ?? "",
    port: parsed?.port ?? "1080",
    username: parsed?.username ?? "",
    password: parsed?.password ?? "",
    name: p.name,
  });
  proxiesMsg.value = "";
  proxiesError.value = "";
}

async function saveProxyEdit(index: number) {
  if (!editProxyForm.name.trim() || !editProxyForm.host.trim()) return;
  const url = buildProxyUrl(editProxyForm);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyEditTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyEditTesting.value = false;
  }

  proxies.value[index] = {
    ...proxies.value[index],
    name: editProxyForm.name.trim(),
    url,
  };
  editingProxyId.value = null;
}

async function saveProxies() {
  proxiesMsg.value = "";
  proxiesError.value = "";
  proxiesSaving.value = true;
  try {
    await settingsApi.update({ proxies: JSON.stringify(proxies.value) });
    proxiesMsg.value = t("settings.saved");
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    proxiesSaving.value = false;
  }
}

async function saveEmby() {
  embyMsg.value = "";
  embyError.value = "";
  embySaving.value = true;
  try {
    await settingsApi.update({
      default_ua: form.default_ua,
      default_play_duration: String(form.default_play_duration),
      default_device_name: form.default_device_name,
      ua_presets: JSON.stringify(uaPresets.value),
    });
    embyMsg.value = t("settings.saved");
  } catch (err: any) {
    embyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    embySaving.value = false;
  }
}

async function saveAi() {
  aiMsg.value = "";
  aiError.value = "";
  aiSaving.value = true;
  try {
    await settingsApi.update({ ai_model: form.ai_model });
    aiMsg.value = t("settings.saved");
  } catch (err: any) {
    aiError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    aiSaving.value = false;
  }
}

async function reloadSuppliers() {
  suppliers.value = await aiSuppliersApi.list();
}

function startEditSupplier(s: AiSupplier) {
  editingSupplierId.value = s.id;
  editForm.name = s.name;
  editForm.base_url = s.base_url;
  editForm.api_key = s.api_key;
  editForm.timeout_ms = s.timeout_ms;
}

async function saveEditSupplier(id: number) {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.update(id, { ...editForm });
    editingSupplierId.value = null;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function createSupplier() {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.create({ ...newSupplierForm });
    showAddSupplier.value = false;
    newSupplierForm.name = "";
    newSupplierForm.base_url = "";
    newSupplierForm.api_key = "";
    newSupplierForm.timeout_ms = 25000;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function removeSupplier(id: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.remove(id);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function addModel(supplierId: number) {
  const modelId = newModelInputs.value[supplierId]?.trim();
  if (!modelId) return;
  supplierError.value = "";
  try {
    await aiSuppliersApi.addModel(supplierId, modelId);
    newModelInputs.value[supplierId] = "";
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function removeModel(supplierId: number, modelId: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.removeModel(supplierId, modelId);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function saveNotify() {
  notifyMsg.value = "";
  notifyError.value = "";
  notifySaving.value = true;
  try {
    await settingsApi.update({
      notify_tg_username: notifyForm.username,
      notify_tg_events: JSON.stringify(notifyForm.events),
    });
    notifyMsg.value = t("settings.saved");
  } catch (err: any) {
    notifyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    notifySaving.value = false;
  }
}

// ── Import / Export ───────────────────────────────────────────────────────────

const fileInput = ref<HTMLInputElement | null>(null);
const importFile = ref<File | null>(null);
const importMode = ref<"merge" | "replace">("merge");
const importing = ref(false);
const importMsg = ref("");
const importError = ref("");

function onFileChange(e: Event) {
  importFile.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

async function doExport() {
  const ok = confirm(t("settings.importExport.exportWarning"));
  if (!ok) return;
  try {
    const data = await dataApi.export();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    a.download = `bemby-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    importError.value =
      err.response?.data?.error ?? t("settings.importExport.importFailed");
  }
}

async function doImport() {
  importMsg.value = "";
  importError.value = "";
  if (!importFile.value) {
    importError.value = t("settings.importExport.noFileSelected");
    return;
  }
  if (importMode.value === "replace") {
    const ok = confirm(t("settings.importExport.replaceWarning"));
    if (!ok) return;
  }
  importing.value = true;
  try {
    const text = await importFile.value.text();
    let parsed: ExportPayload;
    try {
      parsed = JSON.parse(text);
    } catch {
      importError.value = t("settings.importExport.invalidFile");
      return;
    }
    const result = await dataApi.import(parsed, importMode.value);
    importMsg.value = t("settings.importExport.importSuccess")
      .replace("{a}", String(result.accountsImported))
      .replace("{t}", String(result.templatesImported))
      .replace("{j}", String(result.jobsImported))
      .replace("{s}", String(result.settingsUpdated));
    if (fileInput.value) fileInput.value.value = "";
    importFile.value = null;
  } catch (err: any) {
    importError.value =
      err.response?.data?.error ?? t("settings.importExport.importFailed");
  } finally {
    importing.value = false;
  }
}

async function saveCredentials() {
  credMsg.value = "";
  credError.value = "";
  if (!cred.currentPassword) {
    credError.value = t("settings.currentPassRequired");
    return;
  }
  credSaving.value = true;
  try {
    await authApi.changeCredentials(
      cred.currentPassword,
      cred.username || undefined,
      cred.newPassword || undefined,
    );
    credMsg.value = t("settings.credSaved");
    Object.assign(cred, { username: "", newPassword: "", currentPassword: "" });
  } catch (err: any) {
    credError.value = err.response?.data?.error ?? t("settings.credFailed");
  } finally {
    credSaving.value = false;
  }
}
</script>

<style scoped>
.tg-client-mode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.radio-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
}

.event-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.event-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 20px;
  border: 1.5px solid #ddd;
  cursor: pointer;
  font-size: 13px;
  color: #555;
  user-select: none;
  transition:
    border-color 0.15s,
    background 0.15s,
    color 0.15s;
}

.event-pill input[type="checkbox"] {
  display: none;
}

.event-pill.active {
  border-color: var(--color-primary, #2563eb);
  background: #eff6ff;
  color: var(--color-primary, #2563eb);
  font-weight: 500;
}

.event-pill:hover:not(.active) {
  border-color: #bbb;
  background: #fafafa;
}

.ie-divider {
  border: none;
  border-top: 1px solid #eee;
  margin: 16px 0;
}

.import-mode-row {
  display: flex;
  gap: 16px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.import-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.import-mode-option input[type="radio"] {
  margin-top: 3px;
  flex-shrink: 0;
}

.import-mode-label {
  font-size: 13px;
  font-weight: 500;
}

.import-mode-hint {
  font-size: 12px;
  color: #888;
}

.ua-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
}

.ua-preset-name {
  flex: 0 0 140px;
  font-size: 13px;
  font-weight: 500;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ua-preset-value {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.ua-preset-del {
  flex-shrink: 0;
  color: #e63946;
  padding: 3px 7px;
}

.ua-preset-add {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* AI supplier cards */
.supplier-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #fafafa;
}
.supplier-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.supplier-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.supplier-name {
  font-weight: 600;
  font-size: 13px;
}
.supplier-url {
  font-size: 12px;
  color: #6b7280;
  font-family: monospace;
  word-break: break-all;
}
.supplier-timeout {
  font-size: 11px;
  color: #9ca3af;
}
.supplier-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.supplier-edit-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.supplier-no-key-warning {
  margin-top: 8px;
  font-size: 12px;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 5px;
  padding: 5px 10px;
}
.supplier-models {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e5e7eb;
}
.supplier-models-label {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.supplier-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #e5e7eb;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: monospace;
}
.model-chip-del {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: #9ca3af;
  font-size: 11px;
  line-height: 1;
}
.model-chip-del:hover {
  color: #ef4444;
}
.model-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.form-input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: auto;
}
.btn-danger {
  color: #ef4444;
}
.btn-danger:hover {
  color: #dc2626;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 20px;
  align-items: start;
}
.s-col-4 {
  grid-column: span 4;
}
.s-col-6 {
  grid-column: span 6;
}
.s-col-12 {
  grid-column: span 12;
}
@media (max-width: 960px) {
  .s-col-4 {
    grid-column: span 6;
  }
}
@media (max-width: 640px) {
  .s-col-4,
  .s-col-6 {
    grid-column: span 12;
  }
}

.proxy-edit-panel {
  padding: 10px;
  border: 1px solid #e8e8f0;
  border-radius: 6px;
  background: #fafafa;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proxy-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
