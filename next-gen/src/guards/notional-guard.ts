import { Guard, GuardResult, GuardContext } from "./types";
import { NormalizedSignal } from "../types/signal";

export interface NotionalGuardConfig {
  maxNotional: number;
}

export class NotionalGuard implements Guard {
  public readonly name = "NotionalGuard";
  private readonly maxNotional: number;

  constructor(config: NotionalGuardConfig) {
    if (config.maxNotional <= 0) {
      throw new Error("maxNotional must be greater than 0");
    }
    this.maxNotional = config.maxNotional;
  }

  check(signal: NormalizedSignal, _context: GuardContext): GuardResult {
    const notional = signal.quantity * signal.entryPrice;
    const passed = notional <= this.maxNotional;

    return {
      guard: this.name,
      passed,
      reason: passed
        ? `Notional ${notional.toFixed(4)} within limit ${this.maxNotional}`
        : `Notional ${notional.toFixed(4)} exceeds limit ${this.maxNotional}`,
      details: {
        notional,
        maxNotional: this.maxNotional
      }
    };
  }
}

