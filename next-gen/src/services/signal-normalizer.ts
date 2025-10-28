import { AgentAccount, Nof1Response, Position } from "../types/nof1";
import { NormalizedSignal } from "../types/signal";

export interface NormalizationContext {
  receivedAt: Date;
  source?: string;
}

export function normalizeResponse(
  payload: Nof1Response | AgentAccount | AgentAccount[],
  context: NormalizationContext
): NormalizedSignal[] {
  const accounts = Array.isArray(payload)
    ? payload
    : "accountTotals" in (payload as Nof1Response)
    ? (payload as Nof1Response).accountTotals
    : [payload as AgentAccount];

  const receivedIso = context.receivedAt.toISOString();

  const signals: NormalizedSignal[] = [];

  for (const account of accounts) {
    for (const position of Object.values(account.positions)) {
      signals.push(buildSignal(account, position, receivedIso));
    }
  }

  return signals;
}

export function buildSignal(account: AgentAccount, position: Position, receivedAt: string): NormalizedSignal {
  return {
    agentId: account.model_id,
    symbol: position.symbol,
    side: position.quantity >= 0 ? "LONG" : "SHORT",
    quantity: Math.abs(position.quantity),
    leverage: position.leverage,
    entryPrice: position.entry_price,
    entryOid: position.entry_oid,
    signalMarker: account.since_inception_hourly_marker,
    currentPrice: position.current_price,
    receivedAt,
    signalTimestamp: receivedAt
  };
}
