<template>
  <button
    type="button"
    class="btn btn-ghost btn-sm btn-icon"
    :title="t('common.moveUp')"
    :disabled="index === 0"
    @click="emit('move', -1)"
  >
    <i class="fa-solid fa-arrow-up"></i>
  </button>
  <button
    type="button"
    class="btn btn-ghost btn-sm btn-icon"
    :title="t('common.moveDown')"
    :disabled="index === count - 1"
    @click="emit('move', 1)"
  >
    <i class="fa-solid fa-arrow-down"></i>
  </button>
  <button
    type="button"
    class="btn btn-ghost btn-sm btn-icon"
    :title="t('common.insertAfter')"
    @click="emit('insert')"
  >
    <i class="fa-solid fa-plus"></i>
  </button>
  <button
    type="button"
    class="btn btn-danger btn-sm btn-icon"
    :title="t('common.delete')"
    @click="emit('remove')"
  >
    <i class="fa-solid fa-xmark"></i>
  </button>
</template>

<script setup lang="ts">
import { t } from "../i18n";

// The four controls every ordered list in the app carries. Insert is the one that matters most:
// an entry usually belongs somewhere in the middle, and adding at the end and walking it up is
// the same thing, several clicks longer.
defineProps<{ index: number; count: number }>();

const emit = defineEmits<{
  /** -1 up, 1 down */
  move: [by: number];
  insert: [];
  remove: [];
}>();
</script>
