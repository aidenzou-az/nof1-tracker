export interface NormalizedSignal {
  agentId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  leverage: number;
  entryPrice: number;
  entryOid: number;
  signalMarker: number;
  currentPrice: number;
  receivedAt: string;
  signalTimestamp?: string;
}

export interface RawSignalRecord {
  version: 1;
  normalized: NormalizedSignal;
  raw: Record<string, unknown>;
  meta: {
    source: string;
    inputFile?: string;
  };
  receivedAt: string;
  guards?: GuardSnapshot[];
  guardPassed?: boolean;
}

export interface GuardSnapshot {
  guard: string;
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}
