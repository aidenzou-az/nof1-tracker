import { Guard, GuardResult, GuardContext } from "./types";
import { NormalizedSignal } from "../types/signal";

export interface AgeGuardConfig {
  /** 最大允许延迟，单位秒 */
  maxAgeSeconds: number;
}

export class AgeGuard implements Guard {
  public readonly name = "AgeGuard";
  private readonly maxAgeMs: number;

  constructor(config: AgeGuardConfig) {
    if (config.maxAgeSeconds <= 0) {
      throw new Error("maxAgeSeconds must be greater than 0");
    }
    this.maxAgeMs = config.maxAgeSeconds * 1000;
  }

  check(signal: NormalizedSignal, context: GuardContext): GuardResult {
    const now = context.now.getTime();
    const signalTs = this.getSignalTimestamp(signal);

    if (!signalTs) {
      return {
        guard: this.name,
        passed: true,
        reason: "Signal timestamp unavailable; skipping age check",
        details: {
          maxAgeMs: this.maxAgeMs
        }
      };
    }

    const ageMs = now - signalTs;
    const passed = ageMs <= this.maxAgeMs;

    return {
      guard: this.name,
      passed,
      reason: passed
        ? `Signal age ${ageMs}ms within limit ${this.maxAgeMs}ms`
        : `Signal age ${ageMs}ms exceeds limit ${this.maxAgeMs}ms`,
      details: {
        maxAgeMs: this.maxAgeMs,
        ageMs
      }
    };
  }

  private getSignalTimestamp(signal: NormalizedSignal): number | null {
    const candidate = signal.signalTimestamp ?? signal.receivedAt;
    if (!candidate) {
      return null;
    }
    const parsed = Date.parse(candidate);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed;
  }
}

