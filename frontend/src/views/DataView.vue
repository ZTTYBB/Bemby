<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("data.title") }}</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button v-if="folders.length" class="btn btn-secondary" @click="exportStore()">
          <i class="fa-solid fa-download"></i> {{ t("data.exportAll") }}
        </button>
        <button class="btn btn-primary" @click="openFolderForm(null)">
          <i class="fa-solid fa-folder-plus"></i> {{ t("data.addFolder") }}
        </button>
      </div>
    </div>

    <div v-if="!dataStoreEnabled" class="card" style="padding: 16px; color: #888">
      {{ t("data.disabled") }}
    </div>

    <template v-else>
      <div v-if="error" class="error-msg" style="margin-bottom: 12px">{{ error }}</div>

      <p style="color: #888; font-size: 13px; margin: 0 0 12px">{{ t("data.intro") }}</p>

      <div class="data-layout">
        <!-- Folders -->
        <div class="card data-folders">
          <div class="data-panel-title">{{ t("data.foldersTitle") }}</div>
          <div v-if="!folders.length" class="empty" style="padding: 12px">
            {{ t("data.noFolders") }}
          </div>
          <div
            v-for="f in folders"
            :key="f.id"
            class="data-folder-row"
            :class="{ 'is-active': f.id === selectedFolderId }"
            @click="selectFolder(f.id)"
          >
            <i class="fa-solid fa-folder" style="color: #d9a13b"></i>
            <span class="data-folder-name">{{ f.name }}</span>
            <span class="badge badge-grey">{{ f.recordCount }}</span>
            <span class="data-folder-actions" @click.stop>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="openFolderForm(f)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-danger btn-icon"
                :title="t('common.delete')"
                @click="askDeleteFolder(f)"
              >
                <i class="fa-solid fa-trash"></i>
              </button>
            </span>
          </div>
        </div>

        <!-- Records of the chosen folder -->
        <div class="card data-records">
          <div v-if="!selectedFolder" class="empty" style="padding: 16px">
            {{ t("data.selectFolder") }}
          </div>
          <template v-else>
            <div class="data-records-header">
              <div class="data-panel-title" style="margin: 0">
                {{ selectedFolder.name }} — {{ t("data.recordsTitle") }}
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap">
                <button class="btn btn-secondary btn-sm" @click="exportStore(selectedFolder.id)">
                  <i class="fa-solid fa-download"></i> {{ t("data.exportFolder") }}
                </button>
                <button class="btn btn-primary btn-sm" @click="openRecordForm(null)">
                  <i class="fa-solid fa-plus"></i> {{ t("data.addRecord") }}
                </button>
              </div>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width: 22%">{{ t("data.colKey") }}</th>
                    <th>{{ t("data.colValue") }}</th>
                    <th class="col-hide-mobile" style="width: 18%">{{ t("data.colUpdated") }}</th>
                    <th style="width: 15%">{{ t("common.actions") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!records.length">
                    <td colspan="4" class="empty">{{ t("data.noRecords") }}</td>
                  </tr>
                  <tr v-for="r in records" :key="r.id">
                    <td style="font-family: monospace">{{ r.key }}</td>
                    <td class="data-value-cell">{{ previewValue(r.value) }}</td>
                    <td class="col-hide-mobile">{{ fmtDate(r.updatedAt) }}</td>
                    <td>
                      <div class="actions">
                        <button
                          class="btn btn-sm btn-ghost btn-icon"
                          :title="copiedId === r.id ? t('data.copied') : t('data.copyRef')"
                          @click="copyRef(r)"
                        >
                          <i
                            :class="copiedId === r.id ? 'fa-solid fa-check' : 'fa-solid fa-code'"
                          ></i>
                        </button>
                        <button
                          class="btn btn-sm btn-ghost btn-icon"
                          :title="t('common.edit')"
                          @click="openRecordForm(r)"
                        >
                          <i class="fa-solid fa-pen"></i>
                        </button>
                        <button
                          class="btn btn-sm btn-danger btn-icon"
                          :title="t('common.delete')"
                          @click="askDeleteRecord(r)"
                        >
                          <i class="fa-solid fa-trash"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>

      <!-- How a job reaches all this; the reference syntax is the part worth spelling out -->
      <div class="card" style="margin-top: 12px; padding: 12px">
        <div class="data-panel-title">{{ t("data.usageTitle") }}</div>
        <div style="font-size: 12px; color: #888; line-height: 1.7">
          <div>{{ t("data.usageRead") }}</div>
          <div>{{ t("data.usageWrite") }}</div>
        </div>
      </div>
    </template>

    <!-- Add / rename a folder -->
    <div v-if="showFolderForm" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">
          {{ folderTarget ? t("common.edit") : t("data.addFolder") }}
        </h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("data.folderName") }}</label>
            <input
              v-model.trim="folderName"
              class="form-input"
              placeholder="example"
              @keyup.enter="saveFolder"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">
              {{ t("data.nameHint") }}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showFolderForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveFolder">
            <i class="fa-solid fa-check"></i>
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Add / edit a record -->
    <div v-if="showRecordForm" class="modal-backdrop">
      <div class="modal" style="width: 560px">
        <h3 class="modal-title">
          {{ recordTarget ? t("data.editRecord") : t("data.addRecordTitle") }}
        </h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("data.labelKey") }}</label>
            <input v-model.trim="recordKey" class="form-input" placeholder="email" />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">
              {{ t("data.nameHint") }}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("data.labelValue") }}</label>
            <textarea
              v-model="recordValue"
              class="form-input"
              rows="8"
              style="font-family: monospace; font-size: 12px; resize: vertical"
              :placeholder="t('data.valuePlaceholder')"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">
              {{ t("data.valueHint") }}
            </div>
          </div>
          <div v-if="recordKey && selectedFolder" style="font-size: 11px; color: #aaa">
            {{ t("data.refHint") }}
            <code>{{ dataRefText(selectedFolder.name, recordKey) }}</code>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showRecordForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveRecord">
            <i class="fa-solid fa-check"></i>
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete confirmations -->
    <div v-if="deleteFolderTarget" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("common.delete") }}</h3>
        <div class="modal-body">
          {{
            t("data.confirmDeleteFolder")
              .replace("{name}", deleteFolderTarget.name)
              .replace("{n}", String(deleteFolderTarget.recordCount))
          }}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="deleteFolderTarget = null">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" :disabled="saving" @click="doDeleteFolder">
            <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="deleteRecordTarget" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("common.delete") }}</h3>
        <div class="modal-body">
          {{ t("data.confirmDeleteRecord").replace("{name}", deleteRecordTarget.key) }}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="deleteRecordTarget = null">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" :disabled="saving" @click="doDeleteRecord">
            <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "../i18n";
import { dataStoreApi, type DataFolder, type DataRecord } from "../api/client";
import {
  dataRefText,
  dataStoreEnabled,
  loadDataStoreSetting,
  setDataFolderNames,
} from "../composables/dataStore";
import { copyText } from "../utils/clipboard";

// Folders and the records of the one in hand. A value is edited as the text of it: whether
// `{"a":1}` is an object or a string is settled by the backend, so the panel does not have to
// hold a second opinion about it.

const folders = ref<DataFolder[]>([]);
const records = ref<DataRecord[]>([]);
const selectedFolderId = ref<number | null>(null);
const error = ref("");
const saving = ref(false);
const copiedId = ref<number | null>(null);

const showFolderForm = ref(false);
const folderTarget = ref<DataFolder | null>(null);
const folderName = ref("");
const formError = ref("");

const showRecordForm = ref(false);
const recordTarget = ref<DataRecord | null>(null);
const recordKey = ref("");
const recordValue = ref("");

const deleteFolderTarget = ref<DataFolder | null>(null);
const deleteRecordTarget = ref<DataRecord | null>(null);

const selectedFolder = computed(
  () => folders.value.find((f) => f.id === selectedFolderId.value) ?? null,
);

onMounted(async () => {
  await loadDataStoreSetting();
  if (dataStoreEnabled.value) await loadFolders();
});

function reportError(err: any) {
  error.value = err?.response?.data?.error ?? String(err?.message ?? err);
}

async function loadFolders(keepSelection = true) {
  try {
    folders.value = await dataStoreApi.folders();
    setDataFolderNames(folders.value.map((f) => f.name));
    const stillThere = folders.value.some((f) => f.id === selectedFolderId.value);
    if (!keepSelection || !stillThere) {
      selectedFolderId.value = folders.value[0]?.id ?? null;
    }
    await loadRecords();
  } catch (err) {
    reportError(err);
  }
}

async function loadRecords() {
  if (selectedFolderId.value == null) {
    records.value = [];
    return;
  }
  try {
    records.value = await dataStoreApi.records(selectedFolderId.value);
  } catch (err) {
    reportError(err);
  }
}

async function selectFolder(id: number) {
  selectedFolderId.value = id;
  await loadRecords();
}

/** One line of the value for the table: a string as it is, anything else as its JSON. */
function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function openFolderForm(folder: DataFolder | null) {
  folderTarget.value = folder;
  folderName.value = folder?.name ?? "";
  formError.value = "";
  showFolderForm.value = true;
}

async function saveFolder() {
  formError.value = "";
  saving.value = true;
  try {
    if (folderTarget.value) {
      await dataStoreApi.renameFolder(folderTarget.value.id, folderName.value);
    } else {
      const created = await dataStoreApi.createFolder(folderName.value);
      selectedFolderId.value = created.id;
    }
    showFolderForm.value = false;
    await loadFolders();
  } catch (err: any) {
    formError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  } finally {
    saving.value = false;
  }
}

function askDeleteFolder(folder: DataFolder) {
  deleteFolderTarget.value = folder;
}

async function doDeleteFolder() {
  if (!deleteFolderTarget.value) return;
  saving.value = true;
  try {
    await dataStoreApi.deleteFolder(deleteFolderTarget.value.id);
    deleteFolderTarget.value = null;
    await loadFolders(false);
  } catch (err) {
    reportError(err);
  } finally {
    saving.value = false;
  }
}

function openRecordForm(record: DataRecord | null) {
  recordTarget.value = record;
  recordKey.value = record?.key ?? "";
  recordValue.value = record
    ? typeof record.value === "string"
      ? record.value
      : JSON.stringify(record.value, null, 2)
    : "";
  formError.value = "";
  showRecordForm.value = true;
}

async function saveRecord() {
  if (selectedFolderId.value == null) return;
  formError.value = "";
  saving.value = true;
  try {
    if (recordTarget.value) {
      await dataStoreApi.updateRecord(recordTarget.value.id, {
        key: recordKey.value,
        valueText: recordValue.value,
      });
    } else {
      await dataStoreApi.createRecord(
        selectedFolderId.value,
        recordKey.value,
        recordValue.value,
      );
    }
    showRecordForm.value = false;
    await loadFolders();
  } catch (err: any) {
    formError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  } finally {
    saving.value = false;
  }
}

function askDeleteRecord(record: DataRecord) {
  deleteRecordTarget.value = record;
}

async function doDeleteRecord() {
  if (!deleteRecordTarget.value) return;
  saving.value = true;
  try {
    await dataStoreApi.deleteRecord(deleteRecordTarget.value.id);
    deleteRecordTarget.value = null;
    await loadFolders();
  } catch (err) {
    reportError(err);
  } finally {
    saving.value = false;
  }
}

/** The reference a job writes to read this record, on the clipboard. */
async function copyRef(record: DataRecord) {
  const folder = selectedFolder.value?.name ?? "";
  if (!(await copyText(dataRefText(folder, record.key)))) {
    error.value = t("common.copyFailed");
    return;
  }
  copiedId.value = record.id;
  setTimeout(() => (copiedId.value = null), 1500);
}

async function exportStore(folderId?: number) {
  try {
    const payload = await dataStoreApi.export(folderId);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    const name = folderId ? `-${selectedFolder.value?.name ?? folderId}` : "";
    a.download = `bemby-data${name}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    reportError(err);
  }
}
</script>

<style scoped>
.data-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 12px;
  align-items: start;
}

@media (max-width: 900px) {
  .data-layout {
    grid-template-columns: 1fr;
  }
}

.data-folders {
  padding: 8px;
}

.data-records {
  padding: 8px;
  min-width: 0;
}

.data-panel-title {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 4px 6px 8px;
}

.data-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.data-folder-row:hover {
  background: rgba(74, 158, 255, 0.08);
}

.data-folder-row.is-active {
  background: rgba(74, 158, 255, 0.16);
}

.data-folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Kept out of the way until the row is under the pointer, so the list reads as a list */
.data-folder-actions {
  display: none;
  gap: 2px;
}

.data-folder-row:hover .data-folder-actions,
.data-folder-row.is-active .data-folder-actions {
  display: flex;
}

.data-records-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 6px 8px;
}

.data-value-cell {
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
