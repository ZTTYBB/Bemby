<template>
  <div class="mb-backdrop" @click.self="close">
    <div class="mb-panel">
      <div class="mb-head">
        <div class="mb-title">
          <i class="fa-solid fa-desktop"></i>
          {{ t("manualBrowser.title") }}
          <span v-if="session" class="mb-job">{{ session.jobName }}</span>
        </div>
        <!-- Which profile the cookie is about to land in: the whole point of the session -->
        <span v-if="session" class="mb-profile" :title="t('manualBrowser.profileHint')">
          {{ t("manualBrowser.profile") }}: {{ session.profileKey }}
        </span>
        <button
          v-if="props.runId"
          class="btn btn-sm"
          :class="viewOnly ? 'btn-ghost' : 'btn-primary'"
          :disabled="state !== 'live'"
          @click="toggleControl"
        >
          <i class="fa-solid" :class="viewOnly ? 'fa-eye' : 'fa-hand-pointer'"></i>
          {{ viewOnly ? t("manualBrowser.takeControl") : t("manualBrowser.watching") }}
        </button>
        <form v-if="!props.runId" class="mb-address" @submit.prevent="go">
          <input
            v-model.trim="address"
            class="form-input mb-url"
            :placeholder="t('manualBrowser.urlPlaceholder')"
            :disabled="state !== 'live'"
          />
          <button class="btn btn-sm btn-ghost" type="submit" :disabled="state !== 'live' || navigating">
            {{ navigating ? t("manualBrowser.going") : t("manualBrowser.go") }}
          </button>
        </form>
        <span class="mb-state" :class="stateClass">{{ stateText }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="close">
          <i class="fa-solid fa-xmark"></i> {{ t("manualBrowser.close") }}
        </button>
      </div>

      <div v-if="error" class="mb-error">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ error }}
        <button class="btn btn-sm btn-ghost" style="margin-left: 8px" @click="connect">
          {{ t("common.refresh") }}
        </button>
      </div>

      <div ref="screen" class="mb-screen"></div>

      <div class="mb-foot">
        {{ props.runId ? t("manualBrowser.watchHint") : t("manualBrowser.footHint") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from "vue";
import RFB from "@novnc/novnc";
import { t } from "../i18n";
import { manualBrowserApi, type ManualSession } from "../api/client";

// Shows the browser a job runs as, for signing in by hand once so the scheduled runs have
// the cookie. The session belongs to the server: this only opens it, attaches to its screen,
// and closes it again.
const props = defineProps<{ jobId?: number; runId?: string }>();
const emit = defineEmits<{ (e: "closed"): void }>();

const screen = ref<HTMLDivElement>();
const session = ref<ManualSession | null>(null);
const state = ref<"starting" | "connecting" | "live" | "gone">("starting");
const error = ref("");
const busy = ref(false);
const address = ref("");
const viewOnly = ref(!!props.runId);
const navigating = ref(false);
let rfb: any = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;

const stateText = computed(() => t(`manualBrowser.state.${state.value}`));
const stateClass = computed(() => ({
  "mb-live": state.value === "live",
  "mb-warn": state.value === "gone",
}));

function wsUrl(ticket: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/vnc?ticket=${encodeURIComponent(ticket)}`;
}

/** Attaches to the session's screen. A ticket is single-use, so each attempt asks for one. */
async function connect() {
  error.value = "";
  state.value = "connecting";
  try {
    const { session: live, ticket } = session.value
      ? await manualBrowserApi.ticket()
      : props.runId
        ? await manualBrowserApi.watch(props.runId)
        : await manualBrowserApi.start(props.jobId as number);
    session.value = live;
    // Whatever the job opens with, as a starting point to edit
    if (!address.value && live.url && live.url !== "about:blank") address.value = live.url;

    rfb?.disconnect?.();
    rfb = new RFB(screen.value, wsUrl(ticket));
    rfb.scaleViewport = true;
    rfb.clipViewport = true;
    // A run is driving its own browser; a stray click would fight it. Watching starts
    // hands-off and the operator takes over deliberately.
    rfb.viewOnly = viewOnly.value;
    rfb.addEventListener("connect", () => {
      state.value = "live";
    });
    rfb.addEventListener("disconnect", () => {
      // Closing on purpose unmounts this, so a drop here is the browser going away
      if (state.value !== "gone") state.value = "gone";
    });
  } catch (e: any) {
    state.value = "gone";
    error.value = e?.response?.data?.error ?? e?.message ?? String(e);
  }
}

/** Sends the browser to the typed address. */
async function go() {
  if (!address.value || navigating.value) return;
  navigating.value = true;
  error.value = "";
  try {
    const r = await manualBrowserApi.goto(address.value);
    address.value = r.url;
  } catch (e: any) {
    error.value = e?.response?.data?.error ?? e?.message ?? String(e);
  } finally {
    navigating.value = false;
  }
}

/** Hands the pointer and keyboard to the operator, or takes them back. */
function toggleControl() {
  viewOnly.value = !viewOnly.value;
  if (rfb) rfb.viewOnly = viewOnly.value;
}

async function close() {
  if (busy.value) return;
  busy.value = true;
  state.value = "gone";
  try {
    rfb?.disconnect?.();
  } catch {
    /* already gone */
  }
  rfb = null;
  try {
    await manualBrowserApi.stop();
  } catch {
    /* the session may already have timed out */
  }
  busy.value = false;
  emit("closed");
}

onMounted(async () => {
  await connect();
  // Watching without touching anything still counts as being here: the server closes an idle
  // session to free the profile, and a page being read is not idle
  keepAlive = setInterval(() => {
    void manualBrowserApi.status().catch(() => {});
  }, 30_000);
});

onBeforeUnmount(() => {
  if (keepAlive) clearInterval(keepAlive);
  try {
    rfb?.disconnect?.();
  } catch {
    /* already gone */
  }
});
</script>

<style scoped>
.mb-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  padding: 16px;
}

.mb-panel {
  background: #fff;
  border-radius: 8px;
  width: min(1320px, 100%);
  height: min(900px, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
}

.mb-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-job {
  font-weight: 400;
  color: #666;
}

.mb-address {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 1;
  min-width: 0;
  margin-left: 12px;
}

.mb-url {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: 12px;
}

.mb-profile {
  font-size: 11px;
  font-family: monospace;
  background: #eef2ff;
  color: #4338ca;
  padding: 2px 6px;
  border-radius: 8px;
}

.mb-state {
  font-size: 11px;
  color: #888;
}

.mb-live {
  color: #2e9e5b;
}

.mb-warn {
  color: #c47f17;
}

.mb-error {
  padding: 8px 12px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 12px;
}

/* noVNC sizes its canvas to this box */
.mb-screen {
  flex: 1;
  min-height: 0;
  background: #111;
}

.mb-foot {
  padding: 6px 12px;
  border-top: 1px solid #e5e7eb;
  font-size: 11px;
  color: #888;
}
</style>
