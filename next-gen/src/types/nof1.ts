export interface Position {
  symbol: string;
  entry_price: number;
  quantity: number;
  leverage: number;
  current_price: number;
  unrealized_pnl: number;
  confidence?: number;
  entry_oid: number;
  tp_oid?: number;
  sl_oid?: number;
  margin?: number;
  exit_plan: {
    profit_target: number;
    stop_loss: number;
    invalidation_condition?: string;
  };
}

export interface AgentAccount {
  id: string;
  model_id: string;
  since_inception_hourly_marker: number;
  positions: Record<string, Position>;
}

export interface Nof1Response {
  accountTotals: AgentAccount[];
}

