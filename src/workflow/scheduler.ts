/**
 * Workflow Scheduler
 * 주기적으로 워크플로우를 실행하는 스케줄러
 */

import { loadWorkflows, saveWorkflow } from "./storage.js";
import type { Workflow } from "./types.js";

export interface SchedulerCallbacks {
  onWorkflowRun: (workflow: Workflow) => Promise<void>;
  onLog: (message: string) => void;
}

let schedulerInterval: NodeJS.Timeout | null = null;
let callbacks: SchedulerCallbacks | null = null;

/**
 * 다음 실행 시간 계산
 */
function calculateNextRun(workflow: Workflow): number | null {
  const schedule = workflow.schedule;
  if (!schedule || !schedule.enabled) return null;

  const now = Date.now();

  switch (schedule.type) {
    case "interval": {
      const intervalMs = (schedule.intervalMinutes || 60) * 60 * 1000;
      const lastRun = schedule.lastRun || 0;
      return lastRun + intervalMs;
    }

    case "daily": {
      const [hours, minutes] = (schedule.time || "09:00").split(":").map(Number);
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }

    case "weekly": {
      const [hours, minutes] = (schedule.time || "09:00").split(":").map(Number);
      const targetDay = schedule.dayOfWeek ?? 1; // 기본 월요일
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);

      const currentDay = next.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0 || (daysUntil === 0 && next.getTime() <= now)) {
        daysUntil += 7;
      }
      next.setDate(next.getDate() + daysUntil);
      return next.getTime();
    }

    default:
      return null;
  }
}

/**
 * 스케줄 확인 및 실행
 */
async function checkSchedules(): Promise<void> {
  if (!callbacks) return;

  const workflows = loadWorkflows();
  const now = Date.now();

  for (const workflow of workflows) {
    if (!workflow.schedule?.enabled || !workflow.enabled) continue;

    // nextRun이 없으면 계산
    if (!workflow.schedule.nextRun) {
      workflow.schedule.nextRun = calculateNextRun(workflow) || undefined;
      saveWorkflow(workflow);
      continue;
    }

    // 실행 시간이 되었는지 확인
    if (workflow.schedule.nextRun <= now) {
      callbacks.onLog(`[Scheduler] 워크플로우 실행: ${workflow.name}`);

      try {
        await callbacks.onWorkflowRun(workflow);

        // 실행 완료 후 다음 실행 시간 업데이트
        workflow.schedule.lastRun = now;
        workflow.schedule.nextRun = calculateNextRun(workflow) || undefined;
        saveWorkflow(workflow);

        callbacks.onLog(`[Scheduler] 완료: ${workflow.name}, 다음 실행: ${workflow.schedule.nextRun ? new Date(workflow.schedule.nextRun).toLocaleString("ko-KR") : "없음"}`);
      } catch (error) {
        callbacks.onLog(`[Scheduler] 오류: ${workflow.name} - ${(error as Error).message}`);
      }
    }
  }
}

/**
 * 스케줄러 시작
 */
export function startScheduler(cb: SchedulerCallbacks): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  callbacks = cb;

  // 초기 nextRun 계산
  const workflows = loadWorkflows();
  for (const workflow of workflows) {
    if (workflow.schedule?.enabled && !workflow.schedule.nextRun) {
      workflow.schedule.nextRun = calculateNextRun(workflow) || undefined;
      saveWorkflow(workflow);
    }
  }

  // 1분마다 스케줄 확인
  schedulerInterval = setInterval(checkSchedules, 60 * 1000);

  cb.onLog("[Scheduler] 스케줄러 시작됨");

  // 스케줄된 워크플로우 목록 출력
  const scheduled = workflows.filter(w => w.schedule?.enabled && w.enabled);
  if (scheduled.length > 0) {
    cb.onLog(`[Scheduler] 활성화된 스케줄: ${scheduled.length}개`);
    for (const w of scheduled) {
      const nextRun = w.schedule?.nextRun;
      if (nextRun) {
        cb.onLog(`  - ${w.name}: ${new Date(nextRun).toLocaleString("ko-KR")}`);
      }
    }
  }
}

/**
 * 스케줄러 중지
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  callbacks = null;
}

/**
 * 워크플로우의 다음 실행 시간 가져오기
 */
export function getNextRunTime(workflow: Workflow): Date | null {
  const nextRun = calculateNextRun(workflow);
  return nextRun ? new Date(nextRun) : null;
}
