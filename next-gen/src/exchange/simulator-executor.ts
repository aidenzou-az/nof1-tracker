import { ExchangeExecutor, ExecutionReport } from "./types";
import { Decision } from "../types/decision";

export class SimulatorExecutor implements ExchangeExecutor {
  readonly name = "simulator";

  async execute(decision: Decision): Promise<ExecutionReport> {
    console.log(
      `[SIMULATOR] Would execute ${decision.signal.symbol} ${decision.signal.side} quantity=${decision.signal.quantity}`
    );

    return {
      decisionId: decision.id,
      success: true,
      message: "Simulated execution (no external side effects)"
    };
  }
}

