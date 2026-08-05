<template>
  <div>
    <div class="bulk-task-head">
      <span>
        {{ t("bulkTasks.progressLabel") }}: {{ taskDoneCount(task) }} /
        {{ task.total }}
      </span>
      <span v-if="task.state === 'running'" class="bulk-task-running">
        <i class="fa-solid fa-spinner fa-spin"></i>
        {{ t("bulkTasks.state.running") }}
      </span>
      <span v-else class="bulk-task-finished">
        <i class="fa-solid fa-circle-check"></i>
        {{ t(`bulkTasks.state.${task.state}`) }}
      </span>
    </div>
    <p v-if="task.state === 'running'" class="bulk-task-note">
      <i class="fa-solid fa-circle-info"></i> {{ t("bulkTasks.serverNote") }}
    </p>

    <div class="bulk-task-list">
      <div v-for="item in task.items" :key="item.refId" class="bulk-task-item">
        <span class="bulk-task-dot" :class="`status-${item.status}`"></span>
        <div class="bulk-task-item-body">
          <div class="bulk-task-item-top">
            <strong>{{ item.refName }}</strong>
            <span class="bulk-task-item-status">
              {{ t(`bulkTasks.itemStatus.${item.status}`) }}
            </span>
          </div>
          <div
            v-if="bulkTaskItemText(task, item)"
            class="bulk-task-item-msg"
            :class="item.status === 'failed' ? 'bulk-task-item-error' : ''"
          >
            {{ bulkTaskItemText(task, item) }}
          </div>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <button
        v-if="task.state === 'running'"
        class="btn btn-danger"
        :disabled="task.cancelRequested || terminating"
        @click="terminate"
      >
        <i class="fa-solid fa-ban"></i>
        {{
          task.cancelRequested
            ? t("bulkTasks.terminating")
            : t("bulkTasks.terminate")
        }}
      </button>
      <button class="btn btn-primary" @click="emit('close')">
        <i class="fa-solid fa-check"></i> {{ t("common.close") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n";
import type { BulkTask } from "../api/client";
import { cancelBulkTask, taskDoneCount } from "../composables/bulkTasks";
import { bulkTaskItemText } from "../composables/bulkTaskText";

// Progress view for one background bulk task, shared by every bulk modal. The
// task runs on the server, so closing this only hides the view.

const props = defineProps<{ task: BulkTask }>();
const emit = defineEmits<{ (e: "close"): void }>();

const terminating = ref(false);

async function terminate() {
  terminating.value = true;
  try {
    await cancelBulkTask(props.task.id);
  } finally {
    terminating.value = false;
  }
}
</script>

<style scoped>
.bulk-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 6px;
}

.bulk-task-running {
  color: #1296db;
}

.bulk-task-finished {
  color: #52c41a;
}

.bulk-task-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: #8c8c8c;
}

.bulk-task-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 8px;
}

.bulk-task-item {
  display: flex;
  gap: 8px;
  padding: 5px 0;
}

.bulk-task-item + .bulk-task-item {
  border-top: 1px solid #f5f5f5;
}

.bulk-task-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: #d0d0d0;
}

.bulk-task-dot.status-done {
  background: #52c41a;
}

.bulk-task-dot.status-failed {
  background: #ff4d4f;
}

.bulk-task-dot.status-cancelled {
  background: #bfbfbf;
}

.bulk-task-dot.status-working,
.bulk-task-dot.status-waiting {
  background: #1296db;
  animation: bulk-task-pulse 1s ease-in-out infinite;
}

@keyframes bulk-task-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.bulk-task-item-body {
  flex: 1;
  min-width: 0;
}

.bulk-task-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.bulk-task-item-status {
  color: #8c8c8c;
  font-size: 11px;
}

.bulk-task-item-msg {
  font-size: 12px;
  color: #666;
  word-break: break-word;
}

.bulk-task-item-error {
  color: #ff4d4f;
}
</style>
