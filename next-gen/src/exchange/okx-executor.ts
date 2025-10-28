import { Decision } from "../types/decision";
import { ExchangeExecutor, ExecutionReport } from "./types";
import {
  OkxHttpClient,
  OkxInstrumentMeta,
  OkxLeverageParams,
  OkxOrderParams,
  OkxAlgoOrderParams
} from "./okx-http";

const DEFAULT_MARGIN_MODE = (process.env.OKX_MARGIN_MODE ?? "cross").toLowerCase() as
  | "cross"
  | "isolated";
const DEFAULT_LEVERAGE = process.env.OKX_LEVERAGE
  ? parseInt(process.env.OKX_LEVERAGE, 10)
  : undefined;
const FORCE_REDUCE_ONLY = process.env.OKX_FORCE_REDUCE_ONLY === "true";
const POS_MODE = (process.env.OKX_POS_MODE ?? "net").toLowerCase();
const SIMULATED = process.env.OKX_SIMULATED === "true";
const CUSTOM_INST_ID = process.env.OKX_INST_ID;
const INST_SUFFIX = process.env.OKX_INSTRUMENT_SUFFIX ?? "-USDT-SWAP";
const INST_TYPE = (process.env.OKX_INST_TYPE ?? "SWAP").toUpperCase();

interface BalanceInfo {
  currency: string;
  equity: number;
  available: number;
}

interface PositionInfo {
  instId: string;
  posSide?: string;
  pos: number;
  avgPx?: number;
  leverage?: number;
}

interface ExitPlan {
  profit_target?: number;
  stop_loss?: number;
}

interface RawSignalPosition {
  exit_plan?: ExitPlan;
}

interface PositionState {
  sameSideContracts: number;
  oppositeContracts: number;
  entryPosSide?: "long" | "short";
  closePosSide?: "long" | "short";
}

export class OkxExecutor implements ExchangeExecutor {
  readonly name = "okx";
  private readonly client?: OkxHttpClient;

  constructor() {
    const apiKey = process.env.OKX_API_KEY;
    const apiSecret = process.env.OKX_API_SECRET;
    const passphrase = process.env.OKX_API_PASS ?? process.env.OKX_API_PASSPHRASE;

    if (apiKey && apiSecret && passphrase) {
      this.client = new OkxHttpClient(apiKey, apiSecret, passphrase, {
        baseUrl: process.env.OKX_API_BASE,
        simulated: SIMULATED
      });
    }
  }

  async execute(decision: Decision): Promise<ExecutionReport> {
    if (!this.client) {
      return {
        decisionId: decision.id,
        success: false,
        message: "Missing OKX credentials (OKX_API_KEY/SECRET/PASS)"
      };
    }

    const instId = CUSTOM_INST_ID
      ? CUSTOM_INST_ID
      : convertInstrument(decision.signal.symbol, INST_SUFFIX);

    try {
      const instrument = await this.client.getInstrument(instId, INST_TYPE);
      await this.client.ensurePositionMode(POS_MODE === "long_short" ? "long_short" : "net");

      const { balanceInfo, marketPrice, positions } = await this.collectAccountSnapshot(instId);
      logAccountSnapshot(balanceInfo, marketPrice, positions);

      const positionState = analyzePositions(positions, decision.signal.side);
      const ctVal = instrument.ctVal || 1;
      const closableQuantity = positionState.oppositeContracts * ctVal;

      let desiredQuantity = decision.signal.quantity;
      let reduceOnly =
        FORCE_REDUCE_ONLY || decision.reasonCode.includes("EXIT") || closableQuantity > 0;
      let targetPosSide =
        POS_MODE === "long_short"
          ? reduceOnly && closableQuantity > 0
            ? positionState.closePosSide
            : positionState.entryPosSide
          : undefined;

      if (closableQuantity > 0 && desiredQuantity >= closableQuantity) {
        desiredQuantity = closableQuantity;
      }

      if (desiredQuantity <= 0) {
        return {
          decisionId: decision.id,
          success: false,
          message: "Calculated order quantity is zero after adjustments."
        };
      }

      const quantityCheck = verifyQuantity(desiredQuantity, instrument, marketPrice);
      const adjustedQuantity = quantityCheck.adjustedQuantity;
      const notional = adjustedQuantity * marketPrice;

      const leverageCandidate =
        DEFAULT_LEVERAGE ??
        decision.signal.leverage ??
        (positions.find((pos) => pos.pos !== 0)?.leverage || undefined);
      const leverage = leverageCandidate && leverageCandidate > 0 ? leverageCandidate : 1;
      const requiredMargin = notional / leverage;

      if (!reduceOnly && balanceInfo.available < requiredMargin) {
        return {
          decisionId: decision.id,
          success: false,
          message: `Insufficient balance: required ${requiredMargin.toFixed(
            2
          )}, available ${balanceInfo.available.toFixed(2)} ${balanceInfo.currency}`
        };
      }

      console.log("📊 Order context (OKX):");
      console.log(`   Instrument: ${instId}`);
      console.log(`   Side: ${decision.signal.side}`);
      console.log(`   Contracts: ${quantityCheck.contracts}`);
      console.log(`   Quantity: ${adjustedQuantity}`);
      console.log(`   Market price: ${marketPrice.toFixed(2)} ${balanceInfo.currency}`);
      console.log(`   Notional: ${notional.toFixed(2)} ${balanceInfo.currency}`);
      console.log(`   Leverage: ${leverage}x`);
      console.log(`   Reduce only: ${reduceOnly}`);

      await this.configureLeverage(instId, leverage, targetPosSide);

      const orderParams = buildOrderParams({
        instId,
        contracts: quantityCheck.contracts,
        side: decision.signal.side === "LONG" ? "buy" : "sell",
        reduceOnly,
        posSide: targetPosSide
      });

      const response = await this.client.placeOrder(orderParams);

      if (response.sCode && response.sCode !== "0") {
        throw new Error(`OKX error ${response.sCode}: ${response.sMsg}`);
      }

      const stops = await this.setupStops(
        decision,
        instId,
        quantityCheck.contracts,
        reduceOnly,
        positionState.entryPosSide
      );

      const messageParts = [`ordId=${response.ordId ?? "unknown"}`];
      if (stops.algoId) {
        messageParts.push(`tpslAlgo=${stops.algoId}`);
      }

      return {
        decisionId: decision.id,
        success: true,
        message: `Order placed (${messageParts.join(", ")})`
      };
    } catch (error) {
      return {
        decisionId: decision.id,
        success: false,
        message: `Execution failed: ${(error as Error).message}`
      };
    }
  }

  private async setupStops(
    decision: Decision,
    instId: string,
    contracts: number,
    reduceOnly: boolean,
    entryPosSide?: "long" | "short"
  ): Promise<{ algoId?: string }> {
    if (!this.client || reduceOnly) {
      return {};
    }

    const raw = extractRawPosition(decision);
    const exitPlan = raw?.exit_plan;
    if (!exitPlan || (!exitPlan.profit_target && !exitPlan.stop_loss)) {
      return {};
    }

    const params: OkxAlgoOrderParams = {
      instId,
      tdMode: DEFAULT_MARGIN_MODE,
      side: decision.signal.side === "LONG" ? "sell" : "buy",
      ordType: "conditional",
      sz: trimFloat(contracts),
      reduceOnly: "true",
      tpTriggerPx: exitPlan.profit_target ? trimFloat(exitPlan.profit_target) : undefined,
      tpOrdPx: exitPlan.profit_target ? "-1" : undefined,
      slTriggerPx: exitPlan.stop_loss ? trimFloat(exitPlan.stop_loss) : undefined,
      slOrdPx: exitPlan.stop_loss ? "-1" : undefined,
      tpTriggerPxType: "last",
      slTriggerPxType: "last"
    };

    if (POS_MODE === "long_short" && entryPosSide) {
      params.posSide = entryPosSide;
    }

    try {
      console.log("🛡️ Setting TP/SL via algo order:", params);
      const response = await this.client.placeAlgoOrder(params);
      if (response.sCode && response.sCode !== "0") {
        console.warn(`⚠️ Failed to place TP/SL algo: ${response.sMsg ?? response.sCode}`);
        return {};
      }
      return { algoId: response.algoId };
    } catch (error) {
      console.warn(`⚠️ Failed to configure TP/SL: ${(error as Error).message}`);
      return {};
    }
  }

  private async collectAccountSnapshot(instId: string): Promise<{
    balanceInfo: BalanceInfo;
    marketPrice: number;
    positions: PositionInfo[];
  }> {
    if (!this.client) {
      throw new Error("OKX client not available");
    }

    const [balancesRaw, positionsRaw, marketPrice] = await Promise.all([
      this.client.getAccountBalance(),
      this.client.getPositions(instId),
      this.client.getTicker(instId)
    ]);

    const balanceInfo = extractBalance(balancesRaw, instId);
    const positions = extractPositions(positionsRaw, instId);

    return {
      balanceInfo,
      marketPrice,
      positions
    };
  }

  private async configureLeverage(
    instId: string,
    leverage: number,
    posSide?: "long" | "short"
  ): Promise<void> {
    if (!this.client) return;

    const params: OkxLeverageParams = {
      instId,
      lever: String(leverage),
      mgnMode: DEFAULT_MARGIN_MODE
    };

    if (POS_MODE === "long_short" && posSide) {
      params.posSide = posSide;
    }

    await this.client.setLeverage(params);
  }
}

function convertInstrument(symbol: string, suffix: string): string {
  const upper = symbol.toUpperCase();
  if (upper.includes("-")) {
    return upper;
  }

  if (upper.endsWith("USDT")) {
    const base = upper.slice(0, -4);
    return `${base}${suffix.toUpperCase()}`;
  }

  return `${upper}${suffix.toUpperCase()}`;
}

function buildOrderParams(params: {
  instId: string;
  contracts: number;
  side: "buy" | "sell";
  reduceOnly: boolean;
  posSide?: "long" | "short";
}): OkxOrderParams {
  const payload: OkxOrderParams = {
    instId: params.instId,
    tdMode: DEFAULT_MARGIN_MODE,
    side: params.side,
    ordType: "market",
    sz: trimFloat(params.contracts),
    reduceOnly: params.reduceOnly ? "true" : "false"
  };

  if (POS_MODE === "long_short" && params.posSide) {
    payload.posSide = params.posSide;
  }

  return payload;
}

function verifyQuantity(
  quantity: number,
  instrument: OkxInstrumentMeta,
  marketPrice: number
): { contracts: number; minQuantity: number; adjustedQuantity: number } {
  const ctVal = instrument.ctVal || 1;
  const lotSize = instrument.lotSz || 1;
  const minSz = instrument.minSz || lotSize;

  const contractsRaw = quantity / ctVal;
  let contracts = Math.ceil(contractsRaw / lotSize) * lotSize;
  if (contracts < minSz) {
    contracts = minSz;
  }

  const adjustedQuantity = contracts * ctVal;

  console.log("📏 Quantity check:");
  console.log(`   Instrument: ${instrument.instId}`);
  console.log(`   Contract size (ctVal): ${ctVal}`);
  console.log(`   Lot size: ${lotSize}`);
  console.log(`   Min contracts: ${minSz}`);
  console.log(`   Requested quantity: ${quantity}`);
  console.log(`   Adjusted contracts: ${contracts}`);
  console.log(`   Adjusted quantity: ${adjustedQuantity}`);
  console.log(`   Notional @market: ${(adjustedQuantity * marketPrice).toFixed(2)}`);

  return {
    contracts,
    minQuantity: minSz * ctVal,
    adjustedQuantity
  };
}

function analyzePositions(positions: PositionInfo[], side: "LONG" | "SHORT"): PositionState {
  if (POS_MODE === "long_short") {
    const longPos = positions.find((pos) => pos.posSide === "long")?.pos ?? 0;
    const shortPos = positions.find((pos) => pos.posSide === "short")?.pos ?? 0;

    if (side === "LONG") {
      return {
        sameSideContracts: Math.abs(longPos),
        oppositeContracts: Math.abs(shortPos),
        entryPosSide: "long",
        closePosSide: "short"
      };
    }

    return {
      sameSideContracts: Math.abs(shortPos),
      oppositeContracts: Math.abs(longPos),
      entryPosSide: "short",
      closePosSide: "long"
    };
  }

  const net = positions.reduce((sum, pos) => sum + pos.pos, 0);
  if (side === "LONG") {
    return {
      sameSideContracts: net > 0 ? Math.abs(net) : 0,
      oppositeContracts: net < 0 ? Math.abs(net) : 0
    };
  }

  return {
    sameSideContracts: net < 0 ? Math.abs(net) : 0,
    oppositeContracts: net > 0 ? Math.abs(net) : 0
  };
}

function extractBalance(raw: any[], instId: string): BalanceInfo {
  const settleCurrency = instId.split("-")[1] ?? "USDT";
  const account = raw?.[0];
  const detail = account?.details?.find(
    (item: any) => item.ccy?.toUpperCase() === settleCurrency
  );

  const equity = parseFloat(detail?.eq ?? account?.totalEq ?? "0") || 0;
  const available =
    parseFloat(detail?.availBal ?? detail?.availEq ?? detail?.cashBal ?? "0") || 0;

  return {
    currency: settleCurrency,
    equity,
    available
  };
}

function extractPositions(raw: any[], instId: string): PositionInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item) => item.instId === instId)
    .map((item) => ({
      instId: item.instId,
      posSide: item.posSide,
      pos: parseFloat(item.pos ?? "0") || 0,
      avgPx: parseFloat(item.avgPx ?? "0") || undefined,
      leverage: parseFloat(item.lever ?? "0") || undefined
    }));
}

function extractRawPosition(decision: Decision): RawSignalPosition | undefined {
  const raw = decision.raw;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const position = (raw as Record<string, unknown>).position;
  if (position && typeof position === "object") {
    return position as RawSignalPosition;
  }
  return undefined;
}

function logAccountSnapshot(
  balance: BalanceInfo,
  marketPrice: number,
  positions: PositionInfo[]
): void {
  console.log("💰 Account Snapshot (OKX):");
  console.log(`   Equity: ${balance.equity.toFixed(2)} ${balance.currency}`);
  console.log(`   Available: ${balance.available.toFixed(2)} ${balance.currency}`);
  console.log(`   Market Price: ${marketPrice.toFixed(2)}`);

  if (positions.length === 0) {
    console.log("   Positions: none");
  } else {
    console.log("   Positions:");
    for (const pos of positions) {
      if (!pos || pos.pos === 0) continue;
      console.log(
        `     ${pos.instId} ${pos.posSide ?? "net"} ${pos.pos} @ ${
          pos.avgPx ?? "n/a"
        } (lev ${pos.leverage ?? "n/a"})`
      );
    }
  }
}

function trimFloat(value: number): string {
  return value.toFixed(8).replace(/\.0+$/, "").replace(/(\.\d+?)0+$/, "$1");
}
