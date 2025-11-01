import { NormalizedSignal } from "../types/signal";
import { Position } from "../types/nof1";

export interface PositionBundle {
  normalized: NormalizedSignal;
  raw: Record<string, unknown>;
}

export interface PositionSummaryRow {
  agent: string;
  symbol: string;
  hold: string;
  side: string;
  entry: string;
  current: string;
  unrealized: string;
  tp: string;
  sl: string;
}

export interface PositionSnapshotAgent {
  agent: string;
  positions: PositionSnapshotRow[];
}

export interface PositionSnapshotRow {
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  leverage?: number;
  entryPrice?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  profitTarget?: number;
  stopLoss?: number;
}

interface PositionRowRaw {
  agent: string;
  symbol: string;
  quantity: number;
  side: "LONG" | "SHORT";
  leverage?: number;
  entryPrice?: number | null;
  currentPrice?: number | null;
  unrealizedPnl?: number | null;
  profitTarget?: number | null;
  stopLoss?: number | null;
}

export function extractPosition(raw: Record<string, unknown>): Position | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = (raw as Record<string, unknown>).position;
  if (candidate && typeof candidate === "object") {
    return candidate as Position;
  }
  return undefined;
}

export function formatPositionSummary(
  bundles: PositionBundle[],
  heading = "Agent Positions"
): string {
  const rows = collectLatestPositions(bundles);

  const summaries: PositionSummaryRow[] = [];

  for (const row of rows) {
    const holdValue = formatNumber(Math.abs(row.quantity), { digits: 6 });
    const hold =
      holdValue !== "—"
        ? `${holdValue}${row.leverage ? ` @${row.leverage}x` : ""}`
        : row.leverage
        ? `— @${row.leverage}x`
        : "—";

    const entry = formatNumber(row.entryPrice, { digits: 4 });
    const current = formatNumber(row.currentPrice, { digits: 4 });
    const unrealized = formatNumber(row.unrealizedPnl, { digits: 2 });
    const tp = formatNumber(row.profitTarget, { digits: 4 });
    const sl = formatNumber(row.stopLoss, { digits: 4 });

    summaries.push({
      agent: row.agent,
      symbol: row.symbol,
      hold,
      side: row.side,
      entry,
      current,
      unrealized,
      tp,
      sl
    });
  }

  let output = `\n📊 ${heading}\n`;

  if (summaries.length === 0) {
    output += "No active positions.\n\n";
    return output;
  }

  const grouped = new Map<string, PositionSummaryRow[]>();
  for (const summary of summaries) {
    const list = grouped.get(summary.agent);
    if (list) {
      list.push(summary);
    } else {
      grouped.set(summary.agent, [summary]);
    }
  }

  const headers = ["Symbol", "Hold", "Side", "Entry", "Current", "Unrealized", "TP", "SL"];

  for (const [agent, rowsForAgent] of Array.from(grouped.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    output += `\n📦 Agent: ${agent}\n`;

    const values = (row: PositionSummaryRow): string[] => [
      row.symbol,
      row.hold,
      row.side,
      row.entry,
      row.current,
      row.unrealized,
      row.tp,
      row.sl
    ];

    const columnWidths = headers.map((header, index) =>
      Math.max(header.length, ...rowsForAgent.map((row) => values(row)[index].length))
    );

    const topBorder = `┌${columnWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
    const midBorder = `├${columnWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
    const bottomBorder = `└${columnWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;

    const renderRow = (contents: string[]): string =>
      contents
        .map((value, index) => ` ${value.padEnd(columnWidths[index], " ")} `)
        .join("│");

    output += `${topBorder}\n`;
    output += `│${renderRow(headers)}│\n`;
    output += `${midBorder}\n`;
    for (const row of rowsForAgent) {
      output += `│${renderRow(values(row))}│\n`;
    }
    output += `${bottomBorder}\n`;
  }

  output += "\n";
  return output;
}

export function buildPositionSnapshot(bundles: PositionBundle[]): PositionSnapshotAgent[] {
  const rows = collectLatestPositions(bundles);
  const grouped = new Map<string, PositionSnapshotAgent>();

  for (const row of rows) {
    if (!grouped.has(row.agent)) {
      grouped.set(row.agent, { agent: row.agent, positions: [] });
    }

    const bucket = grouped.get(row.agent)!;
    bucket.positions.push({
      symbol: row.symbol,
      side: row.side,
      quantity: Math.abs(row.quantity),
      leverage: row.leverage,
      entryPrice: row.entryPrice ?? undefined,
      currentPrice: row.currentPrice ?? undefined,
      unrealizedPnl: row.unrealizedPnl ?? undefined,
      profitTarget: row.profitTarget ?? undefined,
      stopLoss: row.stopLoss ?? undefined
    });
  }

  return Array.from(grouped.values()).map((entry) => ({
    agent: entry.agent,
    positions: entry.positions.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }));
}

function collectLatestPositions(bundles: PositionBundle[]): PositionRowRaw[] {
  const latest = new Map<
    string,
    {
      bundle: PositionBundle;
      position: Position;
      quantity: number;
      timestamp: number;
      marker?: number;
    }
  >();

  for (const bundle of bundles) {
    const position = extractPosition(bundle.raw);
    if (!position) continue;

    const quantityRaw =
      typeof position.quantity === "number"
        ? position.quantity
        : Number.parseFloat(String(position.quantity ?? NaN));

    if (!Number.isFinite(quantityRaw)) continue;
    const holdQuantity = Math.abs(quantityRaw);
    if (holdQuantity <= 1e-8) continue;

    const key = `${bundle.normalized.agentId}::${bundle.normalized.symbol}`;
    const timestamp = parseTimestamp(bundle.normalized.receivedAt);
    const marker = Number.isFinite(bundle.normalized.signalMarker)
      ? bundle.normalized.signalMarker
      : undefined;

    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, { bundle, position, quantity: quantityRaw, timestamp, marker });
      continue;
    }

    if (
      timestamp > existing.timestamp ||
      (timestamp === existing.timestamp &&
        marker !== undefined &&
        (existing.marker === undefined || marker > existing.marker))
    ) {
      latest.set(key, { bundle, position, quantity: quantityRaw, timestamp, marker });
    }
  }

  const rows: PositionRowRaw[] = [];
  for (const snapshot of latest.values()) {
    const { bundle, position, quantity } = snapshot;
    const leverage =
      bundle.normalized.leverage ??
      (typeof position.leverage === "number" ? position.leverage : undefined);

    const entryPrice = position.entry_price ?? bundle.normalized.entryPrice;
    const currentPrice = position.current_price ?? bundle.normalized.currentPrice;
    const profitTarget = position.exit_plan?.profit_target ?? null;
    const stopLoss = position.exit_plan?.stop_loss ?? null;

    rows.push({
      agent: bundle.normalized.agentId,
      symbol: bundle.normalized.symbol,
      quantity,
      side: quantity >= 0 ? "LONG" : "SHORT",
      leverage,
      entryPrice,
      currentPrice,
      unrealizedPnl: position.unrealized_pnl ?? null,
      profitTarget,
      stopLoss
    });
  }

  return rows;
}

function formatNumber(
  value: unknown,
  options: { digits?: number; fallback?: string } = {}
): string {
  const { digits = 4, fallback = "—" } = options;
  if (value === null || value === undefined) {
    return fallback;
  }

  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  const abs = Math.abs(num);
  let precision = digits;
  if (abs >= 1000) {
    precision = Math.min(2, digits);
  } else if (abs >= 1) {
    precision = Math.min(4, digits);
  } else {
    precision = Math.min(6, digits + 2);
  }

  const fixed = num.toFixed(precision);
  return trimTrailingZeros(fixed);
}

function trimTrailingZeros(input: string): string {
  return input.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return 0;
}
