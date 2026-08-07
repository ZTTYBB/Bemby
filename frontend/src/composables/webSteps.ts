import type { WebStep } from "../api/client";

// Sub-steps of the `open_url` action. The form keeps every field on one flat object, the
// same way the action forms do, so switching a step's type does not throw away what was
// already typed into the fields the other types use. The one exception is `steps`, which a
// loop holds: those are forms of their own, edited by the same editor one level down.

export type WebStepType = WebStep["type"];

export type WebStepForm = {
  type: WebStepType;
  selector: string;
  text: string;
  hint: string;
  waitMs: number;
  scrollX: number;
  scrollY: number;
  url: string;
  varName: string;
  attribute: string;
  /** web_pick / web_collect: only consider candidates whose text contains this. */
  containsText: string;
  pattern: string;
  choose: "first" | "random";
  skipUsed: boolean;
  /** web_collect: keep at most this many values. 0 keeps the lot. */
  limit: number;
  maxChars: number;
  times: number;
  /** web_for_each: stop after this many values. 0 works through the whole list. */
  max: number;
  /** web_press: the key to press, e.g. `Enter` or `Control+Enter`. */
  key: string;
  /** web_select: the option to choose, by its label or its value. */
  option: string;
  /** web_hold: how long to keep the pointer down. */
  holdMs: number;
  /** web_drag: what to drop it on; blank drags by the offset below. */
  toSelector: string;
  /** web_drag: how far to drag when there is no drop target. */
  dragX: number;
  dragY: number;
  /** web_drag: how long the drag itself takes. */
  durationMs: number;
  continueOnError: boolean;
  betweenMs: number;
  check: "element" | "text" | "url";
  negate: boolean;
  /** A loop's steps, or a `web_if`'s then branch; empty for every other type. */
  steps: WebStepForm[];
  /** A `web_if`'s else branch. */
  elseSteps: WebStepForm[];
};

/** Order the editor offers them in: the selector steps first, then waits, then the AI ones. */
export const WEB_STEP_TYPES: WebStepType[] = [
  "web_input",
  "web_button",
  "web_press",
  "web_hold",
  "web_drag",
  "web_select",
  "web_wait_element",
  "web_delay",
  "web_scroll",
  "web_scroll_to",
  "web_turnstile",
  "web_goto",
  "web_back",
  "web_pick",
  "web_collect",
  "web_read",
  "web_if",
  "web_repeat",
  "web_for_each",
  "web_ai_input",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
];

/** Types that need the vision model, so the editor can gate them on a configured key. */
export const AI_WEB_STEP_TYPES: WebStepType[] = [
  "web_ai_input",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
];

/** Types that hold other steps, and so decide what may be offered inside them. */
export const LOOP_WEB_STEP_TYPES: WebStepType[] = ["web_repeat", "web_for_each"];
export const BRANCH_WEB_STEP_TYPE: WebStepType = "web_if";

/** Matches the backend: containers may not nest deeper than this. */
export const MAX_WEB_STEP_DEPTH = 3;

/**
 * What the editor may offer at this point in the nesting. Neither loop can go inside a loop,
 * though both may go inside a branch; nothing may go past the depth limit.
 */
export function offeredWebStepTypes(depth: number, inLoop: boolean): WebStepType[] {
  return WEB_STEP_TYPES.filter((ty) => {
    const container = LOOP_WEB_STEP_TYPES.includes(ty) || ty === BRANCH_WEB_STEP_TYPE;
    if (LOOP_WEB_STEP_TYPES.includes(ty) && inLoop) return false;
    if (container && depth >= MAX_WEB_STEP_DEPTH) return false;
    return true;
  });
}

export function defaultWebStep(): WebStepForm {
  return {
    type: "web_button",
    selector: "",
    text: "",
    hint: "",
    waitMs: 3000,
    scrollX: 0,
    scrollY: 500,
    url: "",
    varName: "",
    attribute: "",
    containsText: "",
    pattern: "",
    choose: "first",
    skipUsed: true,
    limit: 0,
    maxChars: 1000,
    times: 3,
    max: 0,
    key: "Enter",
    option: "",
    holdMs: 1000,
    toSelector: "",
    dragX: 260,
    dragY: 0,
    durationMs: 600,
    continueOnError: true,
    betweenMs: 45000,
    check: "element",
    negate: false,
    steps: [],
    elseSteps: [],
  };
}

/** Drops the fields the chosen type does not use, so the saved config stays readable. */
export function webStepToConfig(s: WebStepForm): WebStep {
  switch (s.type) {
    case "web_input":
      return { type: "web_input", selector: s.selector.trim(), text: s.text };
    case "web_button":
      return { type: "web_button", selector: s.selector.trim() };
    case "web_delay":
      return { type: "web_delay", waitMs: s.waitMs };
    case "web_turnstile":
      return { type: "web_turnstile" };
    case "web_scroll":
      return {
        type: "web_scroll",
        ...(s.scrollX ? { x: s.scrollX } : {}),
        ...(s.scrollY ? { y: s.scrollY } : {}),
      };
    case "web_scroll_to":
      return {
        type: "web_scroll_to",
        selector: s.selector.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_wait_element":
      return {
        type: "web_wait_element",
        selector: s.selector.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_goto":
      return {
        type: "web_goto",
        url: s.url.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_back":
      return { type: "web_back", ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}) };
    case "web_pick":
      return {
        type: "web_pick",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.attribute.trim() ? { attribute: s.attribute.trim() } : {}),
        ...(s.containsText.trim() ? { containsText: s.containsText.trim() } : {}),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.choose === "random" ? { choose: "random" as const } : {}),
        ...(s.skipUsed ? { skipUsed: true } : {}),
      };
    case "web_collect":
      return {
        type: "web_collect",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.attribute.trim() ? { attribute: s.attribute.trim() } : {}),
        ...(s.containsText.trim() ? { containsText: s.containsText.trim() } : {}),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.limit > 0 ? { limit: s.limit } : {}),
        ...(s.skipUsed ? { skipUsed: true } : {}),
      };
    case "web_read":
      return {
        type: "web_read",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.maxChars > 0 ? { maxChars: s.maxChars } : {}),
      };
    case "web_press":
      return {
        type: "web_press",
        key: s.key.trim(),
        ...(s.selector.trim() ? { selector: s.selector.trim() } : {}),
      };
    case "web_hold":
      return {
        type: "web_hold",
        selector: s.selector.trim(),
        ...(s.holdMs > 0 ? { holdMs: s.holdMs } : {}),
      };
    case "web_drag":
      return {
        type: "web_drag",
        selector: s.selector.trim(),
        ...(s.toSelector.trim()
          ? { toSelector: s.toSelector.trim() }
          : {
              ...(s.dragX ? { x: s.dragX } : {}),
              ...(s.dragY ? { y: s.dragY } : {}),
            }),
        ...(s.durationMs > 0 ? { durationMs: s.durationMs } : {}),
      };
    case "web_select":
      return { type: "web_select", selector: s.selector.trim(), option: s.option.trim() };
    case "web_ai_input":
      return {
        type: "web_ai_input",
        selector: s.selector.trim(),
        hint: s.hint.trim(),
        ...(s.maxChars > 0 ? { maxChars: s.maxChars } : {}),
        ...(s.varName.trim() ? { varName: s.varName.trim() } : {}),
      };
    case "web_if":
      return {
        type: "web_if",
        check: s.check,
        ...(s.check === "element" ? { selector: s.selector.trim() } : { text: s.text.trim() }),
        ...(s.negate ? { negate: true } : {}),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
        ...(s.steps.length ? { then: webStepsToConfig(s.steps) } : {}),
        ...(s.elseSteps.length ? { otherwise: webStepsToConfig(s.elseSteps) } : {}),
      };
    case "web_repeat":
      return {
        type: "web_repeat",
        times: s.times,
        ...(s.steps.length ? { steps: webStepsToConfig(s.steps) } : {}),
        ...(s.continueOnError ? {} : { continueOnError: false }),
        ...(s.betweenMs > 0 ? { betweenMs: s.betweenMs } : {}),
      };
    case "web_for_each":
      return {
        type: "web_for_each",
        varName: s.varName.trim(),
        ...(s.steps.length ? { steps: webStepsToConfig(s.steps) } : {}),
        ...(s.max > 0 ? { max: s.max } : {}),
        ...(s.continueOnError ? {} : { continueOnError: false }),
        ...(s.betweenMs > 0 ? { betweenMs: s.betweenMs } : {}),
      };
    case "ai_web_button":
      return { type: "ai_web_button", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_click_xy":
      return { type: "ai_web_click_xy", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_input":
      return {
        type: "ai_web_input",
        ...(s.hint.trim() ? { hint: s.hint.trim() } : {}),
        ...(s.text ? { text: s.text } : {}),
      };
  }
}

export function webStepsToConfig(steps: WebStepForm[]): WebStep[] {
  return steps.map(webStepToConfig);
}

/** Fills the fields a saved step does not carry with the defaults, so the form is complete. */
export function webStepFromConfig(s: WebStep): WebStepForm {
  const base = defaultWebStep();
  switch (s.type) {
    case "web_input":
      return { ...base, type: s.type, selector: s.selector, text: s.text };
    case "web_button":
      return { ...base, type: s.type, selector: s.selector };
    case "web_delay":
      return { ...base, type: s.type, waitMs: s.waitMs };
    case "web_turnstile":
      return { ...base, type: s.type };
    case "web_scroll":
      return { ...base, type: s.type, scrollX: s.x ?? 0, scrollY: s.y ?? 0 };
    case "web_scroll_to":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 5000 };
    case "web_wait_element":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 30000 };
    case "web_goto":
      return { ...base, type: s.type, url: s.url, waitMs: s.waitMs ?? 30000 };
    case "web_back":
      return { ...base, type: s.type, waitMs: s.waitMs ?? 30000 };
    case "web_pick":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        attribute: s.attribute ?? "",
        containsText: s.containsText ?? "",
        pattern: s.pattern ?? "",
        choose: s.choose ?? "first",
        skipUsed: s.skipUsed ?? false,
      };
    case "web_collect":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        attribute: s.attribute ?? "",
        containsText: s.containsText ?? "",
        pattern: s.pattern ?? "",
        limit: s.limit ?? 0,
        skipUsed: s.skipUsed ?? false,
      };
    case "web_read":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        maxChars: s.maxChars ?? 0,
      };
    case "web_press":
      return { ...base, type: s.type, key: s.key, selector: s.selector ?? "" };
    case "web_hold":
      return { ...base, type: s.type, selector: s.selector, holdMs: s.holdMs ?? 1000 };
    case "web_drag":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        toSelector: s.toSelector ?? "",
        dragX: s.x ?? 0,
        dragY: s.y ?? 0,
        durationMs: s.durationMs ?? 600,
      };
    case "web_select":
      return { ...base, type: s.type, selector: s.selector, option: s.option };
    case "web_ai_input":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        hint: s.hint,
        maxChars: s.maxChars ?? 0,
        varName: s.varName ?? "",
      };
    case "web_if":
      return {
        ...base,
        type: s.type,
        check: s.check,
        selector: s.selector ?? "",
        text: s.text ?? "",
        negate: s.negate ?? false,
        waitMs: s.waitMs ?? 5000,
        steps: webStepsFromConfig(s.then),
        elseSteps: webStepsFromConfig(s.otherwise),
      };
    case "web_repeat":
      return {
        ...base,
        type: s.type,
        times: s.times,
        steps: webStepsFromConfig(s.steps),
        continueOnError: s.continueOnError ?? true,
        betweenMs: s.betweenMs ?? 0,
      };
    case "web_for_each":
      return {
        ...base,
        type: s.type,
        varName: s.varName,
        steps: webStepsFromConfig(s.steps),
        max: s.max ?? 0,
        continueOnError: s.continueOnError ?? true,
        betweenMs: s.betweenMs ?? 0,
      };
    case "ai_web_button":
    case "ai_web_click_xy":
      return { ...base, type: s.type, hint: s.hint ?? "" };
    case "ai_web_input":
      return { ...base, type: s.type, hint: s.hint ?? "", text: s.text ?? "" };
  }
}

export function webStepsFromConfig(steps: WebStep[] | undefined): WebStepForm[] {
  return (steps ?? []).map(webStepFromConfig);
}
