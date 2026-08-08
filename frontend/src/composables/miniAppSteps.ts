/**
 * The Mini App in-app steps as the API takes them. Blank rows are dropped, and an empty list is
 * left off altogether, which is what asks the run to auto-detect a checkin-worded control.
 */
export function appButtonsOf(steps: string[]): { appButtons?: string[] } {
  const list = steps.map((s) => s.trim()).filter(Boolean);
  return list.length ? { appButtons: list } : {};
}
