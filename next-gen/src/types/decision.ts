import { NormalizedSignal } from "./signal";
import { ExecutionReport } from "../exchange/types";

export type DecisionAction = "EXECUTE" | "SKIP" | "SIMULATE";

export interface Decision {
  id: string;
  createdAt: string;
  action: DecisionAction;
  reasonCode: string;
  reason?: string;
  signal: NormalizedSignal;
  guards: DecisionGuardSnapshot[];
  meta?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  execution?: DecisionExecutionLog;
}

export interface DecisionGuardSnapshot {
  guard: string;
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DecisionExecutionLog extends ExecutionReport {
  exchange: string;
  executedAt: string;
}
