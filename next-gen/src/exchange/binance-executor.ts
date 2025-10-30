import { Decision } from "../types/decision";
import { ExchangeExecutor, ExecutionReport } from "./types";
import {
  BinanceHttpClient,
  FuturesAccountBalance,
  FuturesPosition,
  PlaceOrderParams
} from "./binance-http";

const TESTNET = process.env.BINANCE_TESTNET === "true";
const DEFAULT_LEVERAGE = process.env.BINANCE_DEFAULT_LEVERAGE
  ? parseInt(process.env.BINANCE_DEFAULT_LEVERAGE, 10)
  : undefined;
const DEFAULT_MARGIN_TYPE = (process.env.BINANCE_MARGIN_TYPE as "ISOLATED" | "CROSSED") || "CROSSED";
const FORCE_REDUCE_ONLY = process.env.BINANCE_FORCE_REDUCE_ONLY === "true";

interface ExitPlan {
  profit_target?: number;
  stop_loss?: number;
}

interface RawSignalPosition {
  exit_plan?: ExitPlan;
}

export class BinanceExecutor implements ExchangeExecutor {
  readonly name = "binance";
  private readonly client?: BinanceHttpClient;

  constructor() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;

    if (apiKey && apiSecret) {
      this.client = new BinanceHttpClient(apiKey, apiSecret, TESTNET);
    }
  }

  async execute(decision: Decision): Promise<ExecutionReport> {
    if (!this.client) {
      return {
        decisionId: decision.id,
        success: false,
        message: "Missing BINANCE_API_KEY/BINANCE_API_SECRET environment variables"
      };
    }

    const symbol = normalizeSymbol(decision.signal.symbol);
    const desiredLeverage = DEFAULT_LEVERAGE ?? decision.signal.leverage ?? 1;

    try {
      await this.configureSymbol(symbol, desiredLeverage);

      const [account, positions, marketPrice] = await Promise.all([
        this.client.getAccountInformation(),
        this.client.getPositions(symbol),
        this.client.getTickerPrice(symbol)
      ]);

      logAccountSnapshot(account, marketPrice, positions);

      const existing = positions.find((position) => position.symbol === symbol);
      const currentAmt = existing?.positionAmt ?? 0;
      const targetAmt = decision.signal.side === "LONG" ? decision.signal.quantity : -decision.signal.quantity;
      const delta = targetAmt - currentAmt;

      if (Math.abs(delta) < 1e-10) {
        return {
          decisionId: decision.id,
          success: true,
          message: "Position already aligned with signal."
        };
      }

      const orderSide = delta > 0 ? "BUY" : "SELL";
      const orderQuantity = Math.abs(delta);
      const sameSign =
        currentAmt !== 0 &&
        targetAmt !== 0 &&
        Math.sign(currentAmt) === Math.sign(targetAmt);
      const pureReduction = sameSign && Math.abs(targetAmt) < Math.abs(currentAmt);
      const closingAll = targetAmt === 0 && currentAmt !== 0;
      const forceReduceOnly = FORCE_REDUCE_ONLY || decision.reasonCode.includes("EXIT");

      if (forceReduceOnly && !pureReduction && !closingAll) {
        return {
          decisionId: decision.id,
          success: false,
          message: "FORCE_REDUCE_ONLY is enabled; refusing to increase exposure."
        };
      }

      const reduceOnly = forceReduceOnly || pureReduction || closingAll;
      const crossingZero =
        currentAmt !== 0 && targetAmt !== 0 && Math.sign(currentAmt) !== Math.sign(targetAmt);

      const leverage = desiredLeverage > 0 ? desiredLeverage : 1;
      if (!reduceOnly && !crossingZero) {
        let additionalQuantity: number;
        if (currentAmt === 0) {
          additionalQuantity = Math.abs(targetAmt);
        } else if (sameSign) {
          additionalQuantity = Math.max(Math.abs(targetAmt) - Math.abs(currentAmt), 0);
        } else {
          additionalQuantity = Math.abs(targetAmt);
        }

        const requiredMargin = (additionalQuantity * marketPrice) / leverage;
        if (additionalQuantity > 0 && account.availableBalance < requiredMargin) {
          return {
            decisionId: decision.id,
            success: false,
            message: `Insufficient balance: required ${requiredMargin.toFixed(
              2
            )}, available ${account.availableBalance.toFixed(2)} USDT`
          };
        }
      }

      const notional = orderQuantity * marketPrice;

      console.log("📊 Order context (Binance):");
      console.log(`   Symbol: ${symbol}`);
      console.log(`   Side: ${orderSide}`);
      console.log(`   Quantity: ${orderQuantity}`);
      console.log(`   Market price: ${marketPrice.toFixed(2)} USDT`);
      console.log(`   Notional: ${notional.toFixed(2)} USDT`);
      console.log(`   Leverage: ${leverage}x`);
      console.log(`   Reduce only: ${reduceOnly}`);

      const orderParams: PlaceOrderParams = {
        symbol,
        side: orderSide,
        type: "MARKET",
        quantity: orderQuantity,
        reduceOnly
      };

      const response = await this.client.placeOrder(orderParams);

      const finalExposure = Math.abs(targetAmt);
      const stops =
        !reduceOnly && finalExposure > 0
          ? await this.setupStops(decision, symbol, orderSide, finalExposure)
          : {};

      const messageParts = [`ordId=${response.orderId}`];
      if (stops.takeProfitId) {
        messageParts.push(`tp=${stops.takeProfitId}`);
      }
      if (stops.stopLossId) {
        messageParts.push(`sl=${stops.stopLossId}`);
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
    symbol: string,
    entrySide: "BUY" | "SELL",
    quantity: number
  ): Promise<{ takeProfitId?: number; stopLossId?: number }> {
    if (!this.client || quantity <= 0) {
      return {};
    }

    const raw = extractRawPosition(decision);
    const exitPlan = raw?.exit_plan;
    if (!exitPlan) {
      return {};
    }

    const stopSide = entrySide === "BUY" ? "SELL" : "BUY";
    const results: { takeProfitId?: number; stopLossId?: number } = {};

    if (exitPlan.profit_target && exitPlan.profit_target > 0) {
      try {
        console.log(`📈 Setting take profit at ${exitPlan.profit_target}`);
        const tpOrder = await this.client.placeOrder({
          symbol,
          side: stopSide,
          type: "TAKE_PROFIT_MARKET",
          quantity,
          stopPrice: exitPlan.profit_target,
          reduceOnly: true,
          workingType: "MARK_PRICE"
        });
        results.takeProfitId = tpOrder.orderId;
      } catch (error) {
        console.warn(
          `⚠️ Failed to place take profit order: ${(error as Error).message}`
        );
      }
    }

    if (exitPlan.stop_loss && exitPlan.stop_loss > 0) {
      try {
        console.log(`📉 Setting stop loss at ${exitPlan.stop_loss}`);
        const slOrder = await this.client.placeOrder({
          symbol,
          side: stopSide,
          type: "STOP_MARKET",
          quantity,
          stopPrice: exitPlan.stop_loss,
          reduceOnly: true,
          workingType: "MARK_PRICE"
        });
        results.stopLossId = slOrder.orderId;
      } catch (error) {
        console.warn(
          `⚠️ Failed to place stop loss order: ${(error as Error).message}`
        );
      }
    }

    return results;
  }

  private async configureSymbol(symbol: string, leverage: number): Promise<void> {
    if (!this.client) return;

    if (DEFAULT_MARGIN_TYPE) {
      try {
        await this.client.setMarginType(symbol, DEFAULT_MARGIN_TYPE);
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes("No need to change margin type")) {
          throw error;
        }
      }
    }

    if (DEFAULT_LEVERAGE) {
      await this.client.setLeverage(symbol, DEFAULT_LEVERAGE);
    } else if (leverage && leverage > 0) {
      await this.client.setLeverage(symbol, leverage);
    }
  }
}

function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  return upper.endsWith("USDT") ? upper : `${upper}USDT`;
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
  balance: FuturesAccountBalance,
  marketPrice: number,
  positions: FuturesPosition[]
): void {
  console.log("💰 Account snapshot (Binance):");
  console.log(`   Available: ${balance.availableBalance.toFixed(2)} USDT`);
  console.log(`   Wallet: ${balance.totalWalletBalance.toFixed(2)} USDT`);
  console.log(`   Market price: ${marketPrice.toFixed(2)} USDT`);

  if (positions.length === 0) {
    console.log("   Positions: none");
    return;
  }

  console.log("   Positions:");
  for (const position of positions) {
    if (!position || Math.abs(position.positionAmt) === 0) continue;
    const direction = position.positionAmt > 0 ? "LONG" : "SHORT";
    console.log(
      `     ${position.symbol} ${direction} ${Math.abs(position.positionAmt)} @ ${position.entryPrice} (lev ${position.leverage})`
    );
  }
}
