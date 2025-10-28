import { NormalizedSignal } from "../types/signal";
import { Position } from "../types/nof1";

export interface GuardContext {
  now: Date;
  rawPosition?: Position;
  meta?: Record<string, unknown>;
}

export interface GuardResult {
  guard: string;
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Guard {
  name: string;
  check(signal: NormalizedSignal, context: GuardContext): GuardResult;
}

