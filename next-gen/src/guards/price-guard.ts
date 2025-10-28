import { Guard, GuardResult, GuardContext } from "./types";
import { NormalizedSignal } from "../types/signal";

export interface PriceGuardConfig {
  tolerancePercentage: number;
}

export class PriceGuard implements Guard {
  public readonly name = "PriceGuard";
  private readonly tolerance: number;

  constructor(config: PriceGuardConfig) {
    if (config.tolerancePercentage <= 0) {
      throw new Error("Price tolerance percentage must be greater than 0");
    }
    this.tolerance = config.tolerancePercentage;
  }

  check(signal: NormalizedSignal, _context: GuardContext): GuardResult {
    const { entryPrice, currentPrice } = signal;

    if (entryPrice <= 0) {
      return {
        guard: this.name,
        passed: false,
        reason: "Invalid entry price detected",
        details: { entryPrice }
      };
    }

    const diff = Math.abs(currentPrice - entryPrice);
    const diffPercent = (diff / entryPrice) * 100;
    const passed = diffPercent <= this.tolerance;

    return {
      guard: this.name,
      passed,
      reason: passed
        ? `Price difference ${diffPercent.toFixed(4)}% within tolerance ${this.tolerance}%`
        : `Price difference ${diffPercent.toFixed(4)}% exceeds tolerance ${this.tolerance}%`,
      details: {
        entryPrice,
        currentPrice,
        diff,
        diffPercent,
        tolerance: this.tolerance
      }
    };
  }
}

