import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether templated jobs get a template-edit button on the jobs
// page. Shared so the setting takes effect without a reload.
const enabled = ref(false);
let loaded = false;

/** Lazy-loads the setting once. Safe to call from any view's onMounted. */
export async function loadTemplateEditButtonSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    enabled.value = s.jobs_template_edit_button === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies the change straight away (called by Settings when the toggle flips). */
export function setTemplateEditButton(value: boolean): void {
  enabled.value = value;
  loaded = true;
}

export { enabled as templateEditButton };
