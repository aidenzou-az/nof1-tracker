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

type OrderSide = "buy" | "sell";

interface PreparedOrder {
  side: OrderSide;
  quantity: number;
  reduceOnly: boolean;
  posSide?: "long" | "short";
}

interface ExecutionContext {
  decision: Decision;
  instId: string;
  instrument: OkxInstrumentMeta;
  leverage: number;
  balanceInfo: BalanceInfo;
  marketPrice: number;
  positions: PositionInfo[];
  client: OkxHttpClient;
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

      const leverageCandidate =
        DEFAULT_LEVERAGE ??
        decision.signal.leverage ??
        (positions.find((pos) => pos.pos !== 0)?.leverage || undefined);
      const leverage = leverageCandidate && leverageCandidate > 0 ? leverageCandidate : 1;

      if (POS_MODE === "long_short") {
        return await this.executeInLongShortMode({
          decision,
          instId,
          instrument,
          leverage,
          balanceInfo,
          marketPrice,
          positions,
          client: this.client
        });
      }

      return await this.executeInNetMode({
        decision,
        instId,
        instrument,
        leverage,
        balanceInfo,
        marketPrice,
        positions,
        client: this.client
      });
    } catch (error) {
      return {
        decisionId: decision.id,
        success: false,
        message: `Execution failed: ${(error as Error).message}`
      };
    }
  }

  private async executeInNetMode(context: ExecutionContext): Promise<ExecutionReport> {
    const {
      decision,
      instId,
      instrument,
      leverage,
      balanceInfo,
      marketPrice,
      positions,
      client
    } = context;
    const ctVal = instrument.ctVal || 1;
    const targetContractsRaw = decision.signal.quantity / ctVal;
    const targetContractsSigned =
      (decision.signal.side === "LONG" ? 1 : -1) * targetContractsRaw;
    const currentNetContracts = positions.reduce((sum, pos) => sum + pos.pos, 0);
    const deltaContracts = targetContractsSigned - currentNetContracts;

    if (Math.abs(deltaContracts) < 1e-8) {
      return {
        decisionId: decision.id,
        success: true,
        message: "Position already aligned with signal."
      };
    }

    const orderSide: OrderSide = deltaContracts > 0 ? "buy" : "sell";
    const desiredQuantity = Math.abs(deltaContracts) * ctVal;
    const pureReduction = isPureReduction(currentNetContracts, targetContractsSigned);
    if (FORCE_REDUCE_ONLY && !pureReduction) {
      return {
        decisionId: decision.id,
        success: false,
        message: "FORCE_REDUCE_ONLY is enabled; refusing to increase exposure."
      };
    }

    const reduceOnly = FORCE_REDUCE_ONLY || pureReduction;
    const rounding = reduceOnly ? "down" : "up";

    const quantityCheck = verifyQuantity(desiredQuantity, instrument, marketPrice, {
      rounding
    });

    if (quantityCheck.contracts <= 0) {
      return {
        decisionId: decision.id,
        success: false,
        message: "Order size below instrument minimum."
      };
    }

    const crossingZero =
      currentNetContracts !== 0 && Math.sign(currentNetContracts) !== Math.sign(targetContractsSigned);
    let requiredMargin = 0;

    if (!reduceOnly && !crossingZero) {
      const additionalContracts = Math.max(
        Math.abs(targetContractsSigned) - Math.abs(currentNetContracts),
        0
      );
      const additionalQuantity = additionalContracts * ctVal;
      requiredMargin = (additionalQuantity * marketPrice) / leverage;

      if (additionalQuantity > 0 && balanceInfo.available < requiredMargin) {
        return {
          decisionId: decision.id,
          success: false,
          message: `Insufficient balance: required ${requiredMargin.toFixed(
            2
          )}, available ${balanceInfo.available.toFixed(2)} ${balanceInfo.currency}`
        };
      }
    }

    const notional = quantityCheck.adjustedQuantity * marketPrice;

    console.log("📊 Order context (OKX):");
    console.log(`   Instrument: ${instId}`);
    console.log(`   Side: ${orderSide} (net)`);
    console.log(`   Contracts: ${quantityCheck.contracts}`);
    console.log(`   Quantity: ${quantityCheck.adjustedQuantity}`);
    console.log(`   Market price: ${marketPrice.toFixed(2)} ${balanceInfo.currency}`);
    console.log(`   Notional: ${notional.toFixed(2)} ${balanceInfo.currency}`);
    console.log(`   Leverage: ${leverage}x`);
    console.log(`   Reduce only: ${reduceOnly}`);
    if (!reduceOnly && !crossingZero && requiredMargin > 0) {
      console.log(`   Margin check (incremental): ${requiredMargin.toFixed(2)} ${balanceInfo.currency}`);
    }

    await this.configureLeverage(instId, leverage);

    const orderParams = buildOrderParams({
      instId,
      contracts: quantityCheck.contracts,
      side: orderSide,
      reduceOnly
    });

    const response = await client.placeOrder(orderParams);

    if (response.sCode && response.sCode !== "0") {
      throw new Error(`OKX error ${response.sCode}: ${response.sMsg}`);
    }

    const stopContracts = verifyQuantity(decision.signal.quantity, instrument, marketPrice, {
      rounding: "down",
      silent: true
    }).contracts;

    const shouldPlaceStops = !reduceOnly && stopContracts > 0;
    const stops = shouldPlaceStops
      ? await this.setupStops(decision, instId, stopContracts, false)
      : {};

    const messageParts = [`ordId=${response.ordId ?? "unknown"}`];
    if (stops.algoId) {
      messageParts.push(`tpslAlgo=${stops.algoId}`);
    }

    return {
      decisionId: decision.id,
      success: true,
      message: `Order placed (${messageParts.join(", ")})`
    };
  }

  private async executeInLongShortMode(context: ExecutionContext): Promise<ExecutionReport> {
    const {
      decision,
      instId,
      instrument,
      leverage,
      balanceInfo,
      marketPrice,
      positions,
      client
    } = context;
    const ctVal = instrument.ctVal || 1;
    const targetContracts = decision.signal.quantity / ctVal;
    const { longContracts, shortContracts } = extractLongShortContracts(positions);
    const orders: PreparedOrder[] = [];

    if (decision.signal.side === "LONG") {
      if (shortContracts > 0) {
        orders.push({
          side: "buy",
          quantity: shortContracts * ctVal,
          reduceOnly: true,
          posSide: "short"
        });
      }

      const deltaLong = targetContracts - longContracts;
      if (Math.abs(deltaLong) > 1e-8) {
        if (deltaLong > 0 && FORCE_REDUCE_ONLY) {
          return {
            decisionId: decision.id,
            success: false,
            message: "FORCE_REDUCE_ONLY is enabled; refusing to increase long exposure."
          };
        }

        orders.push({
          side: deltaLong > 0 ? "buy" : "sell",
          quantity: Math.abs(deltaLong) * ctVal,
          reduceOnly: deltaLong < 0 || FORCE_REDUCE_ONLY,
          posSide: "long"
        });
      }
    } else {
      if (longContracts > 0) {
        orders.push({
          side: "sell",
          quantity: longContracts * ctVal,
          reduceOnly: true,
          posSide: "long"
        });
      }

      const deltaShort = targetContracts - shortContracts;
      if (Math.abs(deltaShort) > 1e-8) {
        if (deltaShort > 0 && FORCE_REDUCE_ONLY) {
          return {
            decisionId: decision.id,
            success: false,
            message: "FORCE_REDUCE_ONLY is enabled; refusing to increase short exposure."
          };
        }

        orders.push({
          side: deltaShort > 0 ? "sell" : "buy",
          quantity: Math.abs(deltaShort) * ctVal,
          reduceOnly: deltaShort < 0 || FORCE_REDUCE_ONLY,
          posSide: "short"
        });
      }
    }

    if (orders.length === 0) {
      return {
        decisionId: decision.id,
        success: true,
        message: "Position already aligned with signal."
      };
    }

    let available = balanceInfo.available;
    const messageParts: string[] = [];

    for (const order of orders) {
      if (order.quantity <= 0) {
        continue;
      }

      const rounding = order.reduceOnly ? "down" : "up";
      const quantityCheck = verifyQuantity(order.quantity, instrument, marketPrice, {
        rounding
      });

      if (quantityCheck.contracts <= 0) {
        if (order.reduceOnly) {
          console.warn(
            `⚠️ Skipping ${order.posSide ?? "net"} reduce-only order; quantity below instrument minimum.`
          );
          continue;
        }
        return {
          decisionId: decision.id,
          success: false,
          message: "Order size below instrument minimum."
        };
      }

      const notional = quantityCheck.adjustedQuantity * marketPrice;
      const requiredMargin = notional / leverage;

      if (!order.reduceOnly && available < requiredMargin) {
        return {
          decisionId: decision.id,
          success: false,
          message: `Insufficient balance: required ${requiredMargin.toFixed(
            2
          )}, available ${available.toFixed(2)} ${balanceInfo.currency}`
        };
      }

      if (!order.reduceOnly) {
        available -= requiredMargin;
      }

      console.log("📊 Order context (OKX):");
      console.log(`   Instrument: ${instId}`);
      console.log(`   Side: ${order.side} (${order.posSide ?? "net"})`);
      console.log(`   Contracts: ${quantityCheck.contracts}`);
      console.log(`   Quantity: ${quantityCheck.adjustedQuantity}`);
      console.log(`   Market price: ${marketPrice.toFixed(2)} ${balanceInfo.currency}`);
      console.log(`   Notional: ${notional.toFixed(2)} ${balanceInfo.currency}`);
      console.log(`   Leverage: ${leverage}x`);
      console.log(`   Reduce only: ${order.reduceOnly}`);

      await this.configureLeverage(instId, leverage, order.posSide);

      const response = await client.placeOrder(
        buildOrderParams({
          instId,
          contracts: quantityCheck.contracts,
          side: order.side,
          reduceOnly: order.reduceOnly,
          posSide: order.posSide
        })
      );

      if (response.sCode && response.sCode !== "0") {
        throw new Error(`OKX error ${response.sCode}: ${response.sMsg}`);
      }

      messageParts.push(`ordId=${response.ordId ?? "unknown"}`);
    }

    if (messageParts.length === 0) {
      return {
        decisionId: decision.id,
        success: false,
        message: "No executable orders after sizing adjustments."
      };
    }

    const stopContracts = verifyQuantity(decision.signal.quantity, instrument, marketPrice, {
      rounding: "down",
      silent: true
    }).contracts;

    const shouldPlaceStops = stopContracts > 0 && decision.signal.quantity > 0;
    const stops = shouldPlaceStops
      ? await this.setupStops(
          decision,
          instId,
          stopContracts,
          false,
          decision.signal.side === "LONG" ? "long" : "short"
        )
      : {};

    if (stops.algoId) {
      messageParts.push(`tpslAlgo=${stops.algoId}`);
    }

    return {
      decisionId: decision.id,
      success: true,
      message: `Order placed (${messageParts.join(", ")})`
    };
  }

  private async setupStops(
    decision: Decision,
    instId: string,
    contracts: number,
    reduceOnly: boolean,
    entryPosSide?: "long" | "short"
  ): Promise<{ algoId?: string }> {
    if (!this.client || reduceOnly || contracts <= 0) {
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
      reduceOnly: true,
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
    reduceOnly: params.reduceOnly
  };

  if (POS_MODE === "long_short" && params.posSide) {
    payload.posSide = params.posSide;
  }

  return payload;
}

function verifyQuantity(
  quantity: number,
  instrument: OkxInstrumentMeta,
  marketPrice: number,
  options: { rounding?: "up" | "down"; silent?: boolean } = {}
): { contracts: number; minQuantity: number; adjustedQuantity: number } {
  const ctVal = instrument.ctVal || 1;
  const lotSize = instrument.lotSz || 1;
  const minSz = instrument.minSz || lotSize;
  const rounding = options.rounding ?? "up";
  const silent = options.silent ?? false;

  if (quantity <= 0 || ctVal <= 0) {
    return {
      contracts: 0,
      minQuantity: minSz * ctVal,
      adjustedQuantity: 0
    };
  }

  const contractsRaw = quantity / ctVal;
  let contracts: number;
  if (rounding === "down") {
    contracts = Math.floor(contractsRaw / lotSize) * lotSize;
    if (contracts < minSz) {
      contracts = 0;
    }
  } else {
    contracts = Math.ceil(contractsRaw / lotSize) * lotSize;
    if (contracts < minSz) {
      contracts = minSz;
    }
  }

  if (contracts < 0) {
    contracts = 0;
  }

  if (contracts === 0) {
    return {
      contracts: 0,
      minQuantity: minSz * ctVal,
      adjustedQuantity: 0
    };
  }

  const adjustedQuantity = contracts * ctVal;

  if (!silent) {
    console.log("📏 Quantity check:");
    console.log(`   Instrument: ${instrument.instId}`);
    console.log(`   Contract size (ctVal): ${ctVal}`);
    console.log(`   Lot size: ${lotSize}`);
    console.log(`   Min contracts: ${minSz}`);
    console.log(`   Requested quantity: ${quantity}`);
    console.log(`   Adjusted contracts: ${contracts}`);
    console.log(`   Adjusted quantity: ${adjustedQuantity}`);
    console.log(`   Notional @market: ${(adjustedQuantity * marketPrice).toFixed(2)}`);
  }

  return {
    contracts,
    minQuantity: minSz * ctVal,
    adjustedQuantity
  };
}

function extractLongShortContracts(positions: PositionInfo[]): {
  longContracts: number;
  shortContracts: number;
} {
  let longContracts = 0;
  let shortContracts = 0;

  for (const pos of positions) {
    if (!pos) continue;
    const value = pos.pos;
    const abs = Math.abs(value);

    if (pos.posSide === "long") {
      longContracts = abs;
    } else if (pos.posSide === "short") {
      shortContracts = abs;
    } else if (value > 0) {
      longContracts = abs;
    } else if (value < 0) {
      shortContracts = abs;
    }
  }

  return { longContracts, shortContracts };
}

function isPureReduction(currentContracts: number, targetContracts: number): boolean {
  if (targetContracts === 0) {
    return currentContracts !== 0;
  }

  if (currentContracts === 0) {
    return false;
  }

  if (Math.sign(currentContracts) !== Math.sign(targetContracts)) {
    return false;
  }

  return Math.abs(targetContracts) < Math.abs(currentContracts);
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
