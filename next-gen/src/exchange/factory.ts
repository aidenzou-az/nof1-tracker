import { ExchangeExecutor, ExecutionReport } from "./types";
import { SimulatorExecutor } from "./simulator-executor";
import { BinanceExecutor } from "./binance-executor";
import { OkxExecutor } from "./okx-executor";

export type SupportedExchange = "simulator" | "binance" | "okx";

export function createExchangeExecutor(name: string | undefined): ExchangeExecutor {
  const normalized = (name ?? "simulator").toLowerCase();

  switch (normalized) {
    case "binance":
      return new BinanceExecutor();
    case "okx":
      return new OkxExecutor();
    case "simulator":
    default:
      return new SimulatorExecutor();
  }
}

export function isExecutionSuccess(report: ExecutionReport): boolean {
  return report.success;
}
