import { ref } from "vue";
import { dataStoreApi, settingsApi } from "../api/client";

// Module-level singleton: whether the data store has its own menu entry and its steps are
// offered in the step editor. Shared so App.vue's menu, the editors and Settings agree the
// moment the toggle flips.
const enabled = ref(false);
let loaded = false;

/** Lazy-loads the setting once. Safe to call from any view's onMounted. */
export async function loadDataStoreSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    enabled.value = s.data_store_enabled === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies the change straight away (called by Settings when the toggle flips). */
export function setDataStoreEnabled(value: boolean): void {
  enabled.value = value;
  loaded = true;
}

/**
 * The reference a job writes to reach a record: the dotted form where the names allow it, and
 * the bracket form for a name holding a dot -- an email address as a key, most often. Mirrors
 * `dataRefText` on the backend, so what is copied here is what the parser reads back.
 */
export function dataRefText(folder: string, key: string, path = ""): string {
  const segment = (name: string) => (name.includes(".") ? `[${name}]` : `.${name}`);
  const tail = path.trim() ? `.${path.trim().replace(/^\.+/, "")}` : "";
  return `{data${segment(folder)}${segment(key)}${tail}}`;
}

// Folder names, for the step editor to suggest: a step pointed at a folder that does not exist
// is the easy mistake to make, and a typo only shows up when the job runs.
const folderNames = ref<string[]>([]);
let namesLoaded = false;

export async function loadDataFolderNames(): Promise<void> {
  if (namesLoaded || !enabled.value) return;
  namesLoaded = true;
  try {
    folderNames.value = (await dataStoreApi.folders()).map((f) => f.name);
  } catch {
    namesLoaded = false;
  }
}

/** Called by the Data view after a folder is added, renamed or removed. */
export function setDataFolderNames(names: string[]): void {
  folderNames.value = names;
  namesLoaded = true;
}

export { enabled as dataStoreEnabled, folderNames as dataFolderNames };
