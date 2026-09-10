export interface EvalFillTask {
  relationId: number;
  type: string;
  rateeContactId: number;
  rateeName: string;
  surveyId: number;
  surveyTitle: string;
  done: boolean;
}

export interface EvalFillTaskGroup {
  cycleId: number;
  cycleName: string;
  cycleStatus: string;
  cycleEndAt?: string | null;
  tasks: EvalFillTask[];
}

export interface EvalFillTaskItem extends EvalFillTask {
  cycleId: number;
  cycleName: string;
  cycleEndAt: string | null;
}

export type EvalDeadlineState = "normal" | "urgent" | "expired" | "none";

function dateValue(value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function buildEvalFillTaskView(groups: EvalFillTaskGroup[]) {
  const tasks = groups.flatMap((group) =>
    group.tasks.map((task) => ({
      ...task,
      cycleId: group.cycleId,
      cycleName: group.cycleName,
      cycleEndAt: group.cycleEndAt || null,
    })),
  );
  const sorter = (left: EvalFillTaskItem, right: EvalFillTaskItem) =>
    dateValue(left.cycleEndAt) - dateValue(right.cycleEndAt) ||
    right.cycleId - left.cycleId ||
    left.relationId - right.relationId;
  const pending = tasks.filter((task) => !task.done).sort(sorter);
  const completed = tasks.filter((task) => task.done).sort(sorter);
  const total = tasks.length;

  return {
    pending,
    completed,
    total,
    completedCount: completed.length,
    progressPercent: total ? Math.round((completed.length / total) * 100) : 0,
    nearestEndAt: pending.find((task) => task.cycleEndAt)?.cycleEndAt || null,
  };
}

export function getEvalDeadlineState(
  endAt: string | null,
  now = new Date(),
): EvalDeadlineState {
  if (!endAt) return "none";
  const remaining = new Date(endAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining)) return "none";
  if (remaining <= 0) return "expired";
  if (remaining <= 72 * 60 * 60 * 1000) return "urgent";
  return "normal";
}

export function getEvalFillDisplayName(token: string) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return "当前员工";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const bytes = Uint8Array.from(atob(padded), (value) =>
      value.charCodeAt(0),
    );
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    return typeof decoded.name === "string" && decoded.name.trim()
      ? decoded.name.trim()
      : "当前员工";
  } catch {
    return "当前员工";
  }
}
