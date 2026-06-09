/**
 * Approval queue — shadow mode's review surface.
 *
 * Externally visible steps (send/post/submit) are staged here instead of
 * fired. One tap approves: the remaining steps run with external actions
 * allowed. Rejection counts as a dismissal signal.
 */

import {
  getApprovalById,
  getPendingApprovals,
  resolveApproval,
  SkillStep,
} from "./db";
import { showNudgeWindow } from "./nudgeWindow";

type ApprovalsChangedFn = () => void;
let onChanged: ApprovalsChangedFn = () => {};

export function registerApprovalsListener(fn: ApprovalsChangedFn): void {
  onChanged = fn;
}

export function pendingApprovals() {
  return getPendingApprovals();
}

/** Surface a staged action to the user immediately via the nudge popup. */
export function notifyApprovalQueued(approvalId: number, description: string): void {
  onChanged();
  showNudgeWindow({
    activityId: -approvalId, // negative namespace: approvals, not activities
    ruleId: -1,
    action: `Staged: ${description.slice(0, 120)}`,
    instruction: "",
    condition: "Review before it goes out",
    onDoIt: () => {
      void approveAndContinue(approvalId);
    },
    onDismiss: () => {
      // Leaving it pending — it stays reviewable in the app.
      onChanged();
    },
  });
}

export async function approveAndContinue(
  approvalId: number
): Promise<{ ok: boolean; error?: string }> {
  const approval = getApprovalById(approvalId);
  if (!approval || approval.status !== "pending") {
    return { ok: false, error: "Approval not found or already resolved" };
  }

  let remainingSteps: SkillStep[] = [];
  try {
    const payload = JSON.parse(approval.payload) as { remainingSteps?: SkillStep[] };
    remainingSteps = payload.remainingSteps ?? [];
  } catch {}

  resolveApproval(approvalId, "approved");
  onChanged();

  if (remainingSteps.length === 0) {
    return { ok: true };
  }

  console.log(`[approvals] #${approvalId} approved — executing ${remainingSteps.length} staged step(s)`);
  const { executeSteps } = await import("./skillEngine");
  const result = await executeSteps(remainingSteps, approval.skill_id);
  if (!result.success) {
    console.error(`[approvals] Continuation failed: ${result.error}`);
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export function rejectApproval(approvalId: number): void {
  resolveApproval(approvalId, "rejected");
  console.log(`[approvals] #${approvalId} rejected`);
  onChanged();
}
