import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";

interface SymbolFilters {
  minQty: number;
  stepSize: number;
  minNotional: number;
  tickSize: number;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  positionSide?: "BOTH" | "LONG" | "SHORT";
}

export interface BinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
  status: string;
  executedQty: string;
}

export interface FuturesAccountBalance {
  availableBalance: number;
  totalWalletBalance: number;
  assets: Array<{
    asset: string;
    availableBalance: number;
    walletBalance: number;
  }>;
}

export interface FuturesPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  leverage: number;
  unrealizedProfit: number;
}

export class BinanceHttpClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly symbolCache = new Map<string, SymbolFilters>();

  constructor(apiKey: string, apiSecret: string, testnet: boolean) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  }

  async placeOrder(params: PlaceOrderParams): Promise<BinanceOrderResponse> {
    const filters = await this.getSymbolFilters(params.symbol);
    const payload: Record<string, string> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: this.adjustQuantity(params.quantity, filters),
      recvWindow: "5000"
    };

    if (params.reduceOnly) {
      payload.reduceOnly = "true";
    }

    if (params.closePosition !== undefined) {
      payload.closePosition = params.closePosition ? "true" : "false";
    }

    if (params.price !== undefined) {
      payload.price = this.formatPrice(params.price, filters);
    }

    if (params.stopPrice !== undefined) {
      payload.stopPrice = this.formatPrice(params.stopPrice, filters);
    }

    if (params.timeInForce) {
      payload.timeInForce = params.timeInForce;
    }

    if (params.workingType) {
      payload.workingType = params.workingType;
    }

    if (params.positionSide) {
      payload.positionSide = params.positionSide;
    }

    payload.newOrderRespType = "RESULT";

    const response = await this.signedRequest("/fapi/v1/order", "POST", payload);
    return response as BinanceOrderResponse;
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await this.signedRequest("/fapi/v1/allOpenOrders", "DELETE", {
      symbol,
      recvWindow: "5000"
    });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest("/fapi/v1/leverage", "POST", {
      symbol,
      leverage: String(leverage),
      recvWindow: "5000"
    });
  }

  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<void> {
    try {
      await this.signedRequest("/fapi/v1/marginType", "POST", {
        symbol,
        marginType,
        recvWindow: "5000"
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("No need to change margin type")) {
        return;
      }
      throw error;
    }
  }

  async getAccountInformation(): Promise<FuturesAccountBalance> {
    const data = (await this.signedRequest("/fapi/v2/account", "GET", {})) as Record<string, unknown>;

    const assetsRaw = Array.isArray(data.assets) ? data.assets : [];
    const assets = assetsRaw.map((asset) => ({
      asset: (asset as any).asset,
      availableBalance: parseFloat((asset as any).availableBalance ?? "0") || 0,
      walletBalance: parseFloat((asset as any).walletBalance ?? "0") || 0
    }));

    return {
      availableBalance: parseFloat((data.availableBalance as string) ?? "0") || 0,
      totalWalletBalance: parseFloat((data.totalWalletBalance as string) ?? "0") || 0,
      assets
    };
  }

  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const params: Record<string, string> = {};
    if (symbol) {
      params.symbol = symbol.toUpperCase();
    }

    const data = (await this.signedRequest("/fapi/v2/positionRisk", "GET", params)) as any[];
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((item) => ({
      symbol: item.symbol,
      positionAmt: parseFloat(item.positionAmt ?? "0") || 0,
      entryPrice: parseFloat(item.entryPrice ?? "0") || 0,
      leverage: parseFloat(item.leverage ?? "0") || 0,
      unrealizedProfit: parseFloat(item.unRealizedProfit ?? item.unrealizedProfit ?? "0") || 0
    }));
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const endpoint = new URL("/fapi/v1/ticker/price", this.baseUrl);
    endpoint.searchParams.set("symbol", symbol.toUpperCase());
    const response = (await this.request(endpoint)) as { price: string };
    const price = parseFloat(response?.price ?? "0");
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Failed to fetch ticker price for ${symbol}`);
    }
    return price;
  }

  private async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const normalized = symbol.toUpperCase();
    if (this.symbolCache.has(normalized)) {
      return this.symbolCache.get(normalized)!;
    }

    const endpoint = new URL("/fapi/v1/exchangeInfo", this.baseUrl);
    const data = (await this.request(endpoint)) as any;
    const symbolInfo = data.symbols?.find((item: any) => item.symbol === normalized);
    if (!symbolInfo) {
      throw new Error(`Symbol ${normalized} not found in Binance exchange info`);
    }

    const lotSize = symbolInfo.filters?.find((f: any) => f.filterType === "LOT_SIZE");
    const priceFilter = symbolInfo.filters?.find((f: any) => f.filterType === "PRICE_FILTER");
    const minNotional = symbolInfo.filters?.find((f: any) => f.filterType === "MIN_NOTIONAL");

    const filters: SymbolFilters = {
      minQty: lotSize ? parseFloat(lotSize.minQty) : 0,
      stepSize: lotSize ? parseFloat(lotSize.stepSize) : 0.001,
      minNotional: minNotional ? parseFloat(minNotional.notional ?? minNotional.minNotional) : 0,
      tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01
    };

    this.symbolCache.set(normalized, filters);
    return filters;
  }

  private adjustQuantity(quantity: number, filters: SymbolFilters): string {
    if (quantity < filters.minQty) {
      quantity = filters.minQty;
    }

    if (filters.stepSize > 0) {
      const steps = Math.floor(quantity / filters.stepSize);
      quantity = steps * filters.stepSize;
    }

    if (quantity <= 0) {
      throw new Error("Quantity adjusted below minimum lot size.");
    }

    return this.formatQuantity(quantity);
  }

  private formatQuantity(quantity: number): string {
    return quantity.toFixed(8).replace(/\.0+$/, "").replace(/(\.\d+?)0+$/, "$1");
  }

  private formatPrice(price: number, filters: SymbolFilters): string {
    if (filters.tickSize > 0) {
      const precision = Math.round(Math.log10(1 / filters.tickSize));
      const scaled = Math.round(price / filters.tickSize) * filters.tickSize;
      return scaled.toFixed(Math.max(0, precision));
    }
    return price.toFixed(2);
  }

  private sign(data: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(data).digest("hex");
  }

  private async signedRequest(
    path: string,
    method: "GET" | "POST" | "DELETE",
    params: Record<string, string>
  ): Promise<unknown> {
    const endpoint = new URL(path, this.baseUrl);
    const payload = new URLSearchParams({
      recvWindow: "5000",
      timestamp: String(Date.now())
    });

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        payload.set(key, value);
      }
    }

    const signature = this.sign(payload.toString());
    payload.append("signature", signature);

    const headers = {
      "X-MBX-APIKEY": this.apiKey
    };

    if (method === "GET") {
      endpoint.search = payload.toString();
      return this.request(endpoint, "GET", undefined, headers);
    }

    return this.request(
      endpoint,
      method,
      payload.toString(),
      {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    );
  }

  private request(
    url: URL,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: string,
    headers?: Record<string, string>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(headers ?? {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              if (!text) {
                resolve({});
                return;
              }
              try {
                resolve(JSON.parse(text));
              } catch (error) {
                reject(new Error(`Failed to parse Binance response: ${(error as Error).message}`));
              }
            } else {
              reject(new Error(`Binance API error (${res.statusCode ?? "unknown"}): ${text}`));
            }
          });
        }
      );

      req.on("error", (error) => reject(error));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}
