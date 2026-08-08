<template>
  <div class="form-group" style="margin-bottom: 0">
    <label class="form-label">{{ label }}</label>
    <select
      :value="modelValue"
      class="form-select"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">{{ blankLabel }}</option>
      <option v-if="allowDirect" value="direct">{{ t("jobs.custom.miniAppProxyDirect") }}</option>
      <option value="random">{{ t("jobs.proxyRandom") }}</option>
      <option v-for="p in proxies" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <div v-if="hint" style="font-size: 11px; color: #aaa; margin-top: 3px">{{ hint }}</div>

    <!-- The pool the draw runs over. Nothing ticked means the whole list, so a pool never
         has to be maintained just to use a random exit -->
    <div v-if="modelValue === 'random'" class="proxy-pool">
      <div class="proxy-pool-head">
        <span class="form-label" style="margin: 0">{{ t("jobs.proxyRandomPoolLabel") }}</span>
        <span class="proxy-pool-count">{{
          pool.length ? `${pool.length}/${proxies.length}` : t("jobs.proxyRandomPoolAll")
        }}</span>
        <button
          v-if="pool.length"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="pool.splice(0, pool.length)"
        >
          {{ t("jobs.proxyRandomPoolClear") }}
        </button>
      </div>
      <div class="proxy-pool-list">
        <label v-for="p in proxies" :key="p.id" class="form-checkbox-label proxy-pool-item">
          <input type="checkbox" :checked="pool.includes(p.id)" @change="toggle(p.id)" />
          {{ p.name }}
        </label>
      </div>
      <div style="font-size: 11px; color: #aaa; margin-top: 3px">
        {{ t("jobs.proxyRandomPoolHint") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from "../i18n";

// Every place an exit can be chosen shows this, so "random" and its pool read and behave the
// same throughout. The pool array is mutated in place: the parent holds it inside its own form
// object, the way the step editors are given their lists.
const props = defineProps<{
  /** Proxy list id, "direct", "random", or "" for the blank option. */
  modelValue: string;
  pool: string[];
  proxies: Array<{ id: string; name: string }>;
  label: string;
  /** What a blank value means here: follow the template, follow the job, or no proxy at all. */
  blankLabel: string;
  hint?: string;
  /** Offer "direct" -- only the browser actions can go out without an exit. */
  allowDirect?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

function toggle(id: string) {
  const at = props.pool.indexOf(id);
  if (at >= 0) props.pool.splice(at, 1);
  else props.pool.push(id);
}
</script>

<style scoped>
.proxy-pool {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
}

.proxy-pool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.proxy-pool-count {
  font-size: 11px;
  color: #888;
  margin-right: auto;
}

/* A synced provider can leave a long list, so the pool scrolls rather than pushing the
   rest of the form off screen */
.proxy-pool-list {
  max-height: 160px;
  overflow-y: auto;
}

.proxy-pool-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}
</style>
