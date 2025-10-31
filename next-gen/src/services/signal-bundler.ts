import { AgentAccount, Position } from "../types/nof1";
import { buildSignal } from "./signal-normalizer";
import { NormalizedSignal, RawSignalRecord } from "../types/signal";

export interface SignalBundle {
  normalized: NormalizedSignal;
  raw: Record<string, unknown>;
  meta: RawSignalRecord["meta"];
}

export function buildBundlesFromAccounts(
  accounts: AgentAccount[],
  source: string,
  inputFile?: string
): SignalBundle[] {
  const bundles: SignalBundle[] = [];

  for (const account of accounts) {
    for (const position of Object.values<Position>(account.positions)) {
      const normalized = buildSignal(account, position, new Date().toISOString());
      bundles.push({
        normalized,
        raw: {
          accountId: account.id,
          modelId: account.model_id,
          position
        },
        meta: {
          source,
          inputFile
        }
      });
    }
  }

  return bundles;
}
