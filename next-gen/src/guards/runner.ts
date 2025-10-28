import { Guard, GuardContext, GuardResult } from "./types";
import { NormalizedSignal } from "../types/signal";

export interface GuardEvaluation {
  signal: NormalizedSignal;
  results: GuardResult[];
  passed: boolean;
}

export function runGuards(
  signal: NormalizedSignal,
  context: GuardContext,
  guards: Guard[]
): GuardEvaluation {
  if (guards.length === 0) {
    return {
      signal,
      results: [],
      passed: true
    };
  }

  const results: GuardResult[] = guards.map((guard) => guard.check(signal, context));
  const passed = results.every((result) => result.passed);

  return {
    signal,
    results,
    passed
  };
}

