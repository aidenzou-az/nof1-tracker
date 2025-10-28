import axios, { AxiosRequestConfig } from "axios";
import crypto from "node:crypto";

export interface OkxInstrumentMeta {
  instId: string;
  instType: string;
  ctVal: number;
  lotSz: number;
  minSz: number;
}

export interface OkxOrderParams {
  instId: string;
  tdMode: "cross" | "isolated";
  side: "buy" | "sell";
  ordType: "market";
  sz: string;
  reduceOnly?: "true" | "false";
  posSide?: "long" | "short";
  [key: string]: string | undefined;
}

export interface OkxOrderResponse {
  ordId: string;
  clOrdId?: string;
  sCode?: string;
  sMsg?: string;
}

export interface OkxAlgoOrderParams {
  instId: string;
  tdMode: "cross" | "isolated";
  side: "buy" | "sell";
  ordType: "conditional" | "oco";
  sz: string;
  reduceOnly?: "true" | "false";
  tpTriggerPx?: string;
  tpOrdPx?: string;
  slTriggerPx?: string;
  slOrdPx?: string;
  posSide?: "long" | "short";
  tpTriggerPxType?: "last" | "index" | "mark";
  slTriggerPxType?: "last" | "index" | "mark";
}

export interface OkxAlgoOrderResponse {
  algoId: string;
  sCode?: string;
  sMsg?: string;
}

export interface OkxLeverageParams {
  instId: string;
  lever: string;
  mgnMode: "cross" | "isolated";
  posSide?: "long" | "short";
  [key: string]: string | undefined;
}

export interface OkxHttpClientOptions {
  baseUrl?: string;
  simulated?: boolean;
}

const DEFAULT_BASE_URL = "https://www.okx.com";

export class OkxHttpClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly baseUrl: string;
  private readonly simulated: boolean;

  private readonly instrumentCache = new Map<string, OkxInstrumentMeta>();
  private positionMode?: "net_mode" | "long_short_mode";

  constructor(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    options: OkxHttpClientOptions = {}
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.simulated = options.simulated ?? false;
  }

  async placeOrder(params: OkxOrderParams): Promise<OkxOrderResponse> {
    const endpoint = "/api/v5/trade/order";
    const payload = {
      ...params,
      reduceOnly: params.reduceOnly ?? "false"
    };

    const response = await this.request("POST", endpoint, payload);
    const [result] = (response as any[]) ?? [];

    return {
      ordId: result?.ordId ?? "",
      clOrdId: result?.clOrdId,
      sCode: result?.sCode,
      sMsg: result?.sMsg
    };
  }

  async placeAlgoOrder(params: OkxAlgoOrderParams): Promise<OkxAlgoOrderResponse> {
    const endpoint = "/api/v5/trade/order-algo";
    const payload: Record<string, unknown> = { ...params };
    const response = await this.request("POST", endpoint, payload);
    const [result] = (response as any[]) ?? [];

    return {
      algoId: result?.algoId ?? "",
      sCode: result?.sCode,
      sMsg: result?.sMsg
    };
  }

  async cancelAlgoOrders(
    orders: Array<{ algoId: string; instId: string; ordType?: "conditional" | "oco" }>
  ): Promise<void> {
    if (orders.length === 0) {
      return;
    }

    await this.request("POST", "/api/v5/trade/cancel-algos", orders as unknown as Array<unknown>);
  }

  async setLeverage(params: OkxLeverageParams): Promise<void> {
    await this.request("POST", "/api/v5/account/set-leverage", params);
  }

  async ensurePositionMode(mode: "net" | "long_short"): Promise<void> {
    const target = mode === "long_short" ? "long_short_mode" : "net_mode";
    if (this.positionMode === target) {
      return;
    }

    try {
      await this.request("POST", "/api/v5/account/set-position-mode", {
        posMode: target
      });
      this.positionMode = target;
    } catch (error) {
      const message = (error as Error).message;
      if (
        message.includes("Operation failed") ||
        message.includes("Same mode")
      ) {
        this.positionMode = target;
        return;
      }
      throw error;
    }
  }

  async getInstrument(
    instId: string,
    instType: string
  ): Promise<OkxInstrumentMeta> {
    const cacheKey = `${instType}_${instId}`;
    if (this.instrumentCache.has(cacheKey)) {
      return this.instrumentCache.get(cacheKey)!;
    }

    const response = (await this.request(
      "GET",
      "/api/v5/public/instruments",
      {
        instType,
        instId
      }
    )) as any[];

    const instrument = response?.find((item) => item.instId === instId);
    if (!instrument) {
      throw new Error(`Instrument ${instId} not found on OKX`);
    }

    const meta: OkxInstrumentMeta = {
      instId,
      instType,
      ctVal: parseFloat(instrument.ctVal ?? "0"),
      lotSz: parseFloat(instrument.lotSz ?? "1"),
      minSz: parseFloat(instrument.minSz ?? "1")
    };

    this.instrumentCache.set(cacheKey, meta);
    return meta;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown> | Array<unknown>
  ): Promise<unknown> {
    let requestPath = path;
    let bodyString = "";

    if (method === "GET" && params && !Array.isArray(params)) {
      const query = buildQuery(params);
      if (query) {
        requestPath = `${path}?${query}`;
      }
    } else if (method === "POST" && params !== undefined) {
      bodyString = JSON.stringify(params);
    }

    const timestamp = new Date().toISOString();
    const sign = this.sign(timestamp, method, requestPath, bodyString);

    const config: AxiosRequestConfig = {
      method,
      url: `${this.baseUrl}${requestPath}`,
      headers: {
        "OK-ACCESS-KEY": this.apiKey,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": this.passphrase,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    };

    if (this.simulated) {
      (config.headers as Record<string, unknown>)["x-simulated-trading"] = 1;
    }

    if (method === "POST" && bodyString) {
      config.data = bodyString;
    }

    try {
      const response = await axios(config);
      const data = response.data;
      if (data?.code && data.code !== "0") {
        throw new Error(`OKX API error (${data.code}): ${data.msg}`);
      }
      return data?.data ?? [];
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const data = error.response.data;
        throw new Error(
          `OKX request failed (${error.response.status}): ${
            typeof data === "string" ? data : JSON.stringify(data)
          }`
        );
      }
      throw error;
    }
  }

  private sign(
    timestamp: string,
    method: "GET" | "POST",
    path: string,
    body: string
  ): string {
    const message = `${timestamp}${method}${path}${body}`;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("base64");
  }

  async getAccountBalance(): Promise<any[]> {
    return (await this.request("GET", "/api/v5/account/balance")) as any[];
  }

  async getPositions(instId?: string): Promise<any[]> {
    const params = instId ? { instId } : undefined;
    return (await this.request("GET", "/api/v5/account/positions", params)) as any[];
  }

  async getTicker(instId: string): Promise<number> {
    const data = (await this.request("GET", "/api/v5/market/ticker", {
      instId
    })) as any[];
    const price = data?.[0]?.last ?? data?.[0]?.idxPx;
    const num = parseFloat(price ?? "0");
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`Failed to fetch ticker for ${instId}`);
    }
    return num;
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}
