<template>
  <div>
    <label class="form-label">{{ heading.label }}</label>
    <div style="font-size: 11px; color: #aaa; margin: -2px 0 6px">
      {{ heading.hint }}
    </div>

    <div v-for="(s, i) in steps" :key="i" class="web-step-card">
      <div class="web-step-header">
        <span class="web-step-num">{{ i + 1 }}</span>
        <select v-model="s.type" class="form-select web-step-type">
          <option
            v-for="ty in offeredTypes"
            :key="ty"
            :value="ty"
            :disabled="aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)"
          >
            {{ t("jobs.web.type." + ty)
            }}{{
              aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)
                ? " (" + t("jobs.noApiKey") + ")"
                : ""
            }}
          </option>
        </select>
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-icon"
          :disabled="i === 0"
          @click="move(i, -1)"
        >
          <i class="fa-solid fa-arrow-up"></i>
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-icon"
          :disabled="i === steps.length - 1"
          @click="move(i, 1)"
        >
          <i class="fa-solid fa-arrow-down"></i>
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-icon" @click="remove(i)">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- CSS selector: every type but the AI ones and the plain delay -->
      <div
        v-if="
          s.type === 'web_input' ||
          s.type === 'web_button' ||
          s.type === 'web_wait_element' ||
          s.type === 'web_pick' ||
          s.type === 'web_read'
        "
      >
        <label class="form-label">{{ t("jobs.web.labelSelector") }}</label>
        <input
          v-model.trim="s.selector"
          class="form-input"
          :placeholder="t('jobs.web.selectorPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.selectorHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.textPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.textHint") }}
        </div>
      </div>

      <!-- The address a goto opens, and the list a collect or a loop works with -->
      <div v-if="s.type === 'web_goto'">
        <label class="form-label">{{ t("jobs.web.labelUrl") }}</label>
        <input v-model.trim="s.url" class="form-input" :placeholder="t('jobs.web.gotoPlaceholder')" />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.gotoHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_pick' || s.type === 'web_read'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="
                s.type === 'web_read'
                  ? t('jobs.web.readNamePlaceholder')
                  : t('jobs.web.varNamePlaceholder')
              "
            />
          </div>
          <div v-if="s.type === 'web_pick'" class="form-group">
            <label class="form-label">{{ t("jobs.web.labelAttribute") }}</label>
            <input
              v-model.trim="s.attribute"
              class="form-input"
              :placeholder="t('jobs.web.attributePlaceholder')"
            />
          </div>
          <div v-else class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxChars") }}</label>
            <input v-model.number="s.maxChars" class="form-input" type="number" min="0" step="100" />
          </div>
        </div>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ s.type === "web_read" ? t("jobs.web.readHint") : t("jobs.web.pickHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_pick'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelPattern") }}</label>
            <input
              v-model.trim="s.pattern"
              class="form-input"
              :placeholder="t('jobs.web.patternPlaceholder')"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">
              {{ t("jobs.web.patternHint") }}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelChoose") }}</label>
            <select v-model="s.choose" class="form-select">
              <option value="first">{{ t("jobs.web.chooseFirst") }}</option>
              <option value="random">{{ t("jobs.web.chooseRandom") }}</option>
            </select>
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">
              {{ t("jobs.web.chooseHint") }}
            </div>
          </div>
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.skipUsed" type="checkbox" />
          {{ t("jobs.web.labelSkipUsed") }}
        </label>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.skipUsedHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_if'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelCheck") }}</label>
            <select v-model="s.check" class="form-select">
              <option value="element">{{ t("jobs.web.checkElement") }}</option>
              <option value="text">{{ t("jobs.web.checkText") }}</option>
              <option value="url">{{ t("jobs.web.checkUrl") }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{
              s.check === "element" ? t("jobs.web.labelSelector") : t("jobs.web.labelWords")
            }}</label>
            <input
              v-if="s.check === 'element'"
              v-model.trim="s.selector"
              class="form-input"
              :placeholder="t('jobs.web.ifSelectorPlaceholder')"
            />
            <input
              v-else
              v-model.trim="s.text"
              class="form-input"
              :placeholder="t('jobs.web.wordsPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.ifHint") }}
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.negate" type="checkbox" />
          {{ t("jobs.web.labelNegate") }}
        </label>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.negateHint") }}
        </div>

        <div style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelIfWait") }}</label>
          <input v-model.number="s.waitMs" class="form-input" type="number" min="0" step="1000" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">
            {{ t("jobs.web.ifWaitHint") }}
          </div>
        </div>

        <div class="web-branch-body web-branch-then">
          <WebStepsEditor
            :steps="s.steps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            :in-loop="inLoop"
            role="then"
          />
        </div>
        <div class="web-branch-body web-branch-else">
          <WebStepsEditor
            :steps="s.elseSteps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            :in-loop="inLoop"
            role="else"
          />
        </div>
      </div>

      <div v-if="s.type === 'web_repeat'">
        <div>
          <label class="form-label">{{ t("jobs.web.labelTimes") }}</label>
          <input v-model.number="s.times" class="form-input" type="number" min="1" step="1" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">
            {{ t("jobs.web.timesHint") }}
          </div>
        </div>

        <div style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelBetween") }}</label>
          <input v-model.number="s.betweenMs" class="form-input" type="number" min="0" step="1000" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">
            {{ t("jobs.web.betweenHint") }}
          </div>
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.continueOnError" type="checkbox" />
          {{ t("jobs.web.labelContinueOnError") }}
        </label>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.continueOnErrorHint") }}
        </div>

        <!-- A loop's rounds: no loop inside a loop, which the nested list enforces -->
        <div class="web-loop-body">
          <WebStepsEditor
            :steps="s.steps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            in-loop
            role="loop"
          />
        </div>
      </div>

      <div
        v-if="
          s.type === 'web_delay' ||
          s.type === 'web_wait_element' ||
          s.type === 'web_goto' ||
          s.type === 'web_back'
        "
        style="margin-top: 8px"
      >
        <label class="form-label">{{
          s.type === "web_delay" ? t("jobs.web.labelDelay") : t("jobs.web.labelTimeout")
        }}</label>
        <input v-model.number="s.waitMs" class="form-input" type="number" min="0" step="1000" />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{
            s.type === "web_delay" ? t("jobs.web.delayHint") : t("jobs.web.timeoutHint")
          }}
        </div>
      </div>

      <div v-if="s.type === 'web_scroll'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollX") }}</label>
            <input v-model.number="s.scrollX" class="form-input" type="number" step="100" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollY") }}</label>
            <input v-model.number="s.scrollY" class="form-input" type="number" step="100" />
          </div>
        </div>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.scrollHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_turnstile'" style="font-size: 11px; color: #aaa">
        {{ t("jobs.web.turnstileHint") }}
      </div>

      <div v-if="s.type === 'web_back'" style="font-size: 11px; color: #aaa">
        {{ t("jobs.web.backHint") }}
      </div>

      <div
        v-if="
          s.type === 'ai_web_button' || s.type === 'ai_web_input' || s.type === 'ai_web_click_xy'
        "
      >
        <label class="form-label">{{ t("jobs.web.labelHint") }}</label>
        <input
          v-model.trim="s.hint"
          class="form-input"
          :placeholder="hintPlaceholder(s.type)"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ s.type === "ai_web_click_xy" ? t("jobs.web.hintXyHint") : t("jobs.web.hintHint") }}
        </div>
      </div>

      <div v-if="s.type === 'ai_web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelAiText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.aiTextPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.aiTextHint") }}
        </div>
      </div>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.web.addStep") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import {
  AI_WEB_STEP_TYPES,
  defaultWebStep,
  offeredWebStepTypes,
  type WebStepForm,
  type WebStepType,
} from "../composables/webSteps";

// The list is mutated in place: the parent holds it inside its own action form object, so
// emitting a replacement would mean threading an update back through the action index.
//
// The component recurses for a loop's rounds and a branch's two arms. `depth` and `inLoop`
// are what keep that in step with the backend's own limits: a loop cannot be offered inside
// another loop, and nothing may nest past the depth cap.
const props = defineProps<{
  steps: WebStepForm[];
  aiKeyMissing: boolean;
  depth?: number;
  inLoop?: boolean;
  /** Which heading to show: the action's own steps, a loop's, or one arm of a branch. */
  role?: "steps" | "loop" | "then" | "else";
}>();

const offeredTypes = computed(() => offeredWebStepTypes(props.depth ?? 0, props.inLoop ?? false));

const heading = computed(() => {
  switch (props.role) {
    case "loop":
      return { label: t("jobs.web.loopStepsLabel"), hint: t("jobs.web.loopStepsHint") };
    case "then":
      return { label: t("jobs.web.thenStepsLabel"), hint: t("jobs.web.thenStepsHint") };
    case "else":
      return { label: t("jobs.web.elseStepsLabel"), hint: t("jobs.web.elseStepsHint") };
    default:
      return { label: t("jobs.web.stepsLabel"), hint: t("jobs.web.stepsHint") };
  }
});

function hintPlaceholder(type: WebStepType): string {
  if (type === "ai_web_input") return t("jobs.web.hintInputPlaceholder");
  if (type === "ai_web_click_xy") return t("jobs.web.hintXyPlaceholder");
  return t("jobs.web.hintButtonPlaceholder");
}

function add() {
  props.steps.push(defaultWebStep());
}

function remove(i: number) {
  props.steps.splice(i, 1);
}

function move(i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= props.steps.length) return;
  const [item] = props.steps.splice(i, 1);
  props.steps.splice(to, 0, item);
}
</script>

<style scoped>
.web-step-card {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  /* The parent action card is #fafafa, so these sit a shade lighter to read as nested */
  background: #fff;
}

.web-step-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

/* A loop's own steps, set in from the loop's fields so the nesting reads at a glance */
.web-loop-body {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid #4a9eff;
}

/* The two arms of a condition, told apart by colour: taken on yes, taken on no */
.web-branch-body {
  margin-top: 10px;
  padding-left: 10px;
}

.web-branch-then {
  border-left: 2px solid #2e9e5b;
}

.web-branch-else {
  border-left: 2px solid #d98324;
}

.web-step-num {
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #4a9eff;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.web-step-type {
  flex: 1;
  min-width: 0;
}
</style>
