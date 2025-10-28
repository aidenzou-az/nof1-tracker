import { Decision } from "../types/decision";

export interface ExecutionReport {
  decisionId: string;
  success: boolean;
  message?: string;
}

export interface ExchangeExecutor {
  readonly name: string;

  /**
   * Execute the provided decision on the target exchange.
   * Only decisions with action === "EXECUTE" should be passed in.
   */
  execute(decision: Decision): Promise<ExecutionReport>;
}

