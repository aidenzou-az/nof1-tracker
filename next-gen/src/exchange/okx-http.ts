import {
  RestClient,
  type AlgoOrderRequest,
  type AlgoOrderResult,
  type CancelAlgoOrderRequest,
  type Instrument,
  type InstrumentType,
  type OrderRequest,
  type OrderResult,
  type Ticker
} from "okx-api";

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
  reduceOnly?: boolean;
  posSide?: "long" | "short";
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
  reduceOnly?: boolean;
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
}

export interface OkxHttpClientOptions {
  baseUrl?: string;
  simulated?: boolean;
}

type PositionMode = "net_mode" | "long_short_mode";

export class OkxHttpClient {
  private readonly client: RestClient;
  private readonly instrumentCache = new Map<string, OkxInstrumentMeta>();
  private positionMode?: PositionMode;

  constructor(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    options: OkxHttpClientOptions = {}
  ) {
    this.client = new RestClient({
      apiKey,
      apiSecret,
      apiPass: passphrase,
      baseUrl: options.baseUrl,
      demoTrading: options.simulated ?? false,
      parse_exceptions: false
    });
  }

  async placeOrder(params: OkxOrderParams): Promise<OkxOrderResponse> {
    const request: OrderRequest = {
      instId: params.instId,
      tdMode: params.tdMode,
      side: params.side,
      ordType: params.ordType,
      sz: params.sz,
      posSide: params.posSide,
      reduceOnly: params.reduceOnly
    };

    const [result] = await this.client.submitOrder(request);
    return normalizeOrderResult(result);
  }

  async placeAlgoOrder(params: OkxAlgoOrderParams): Promise<OkxAlgoOrderResponse> {
    const request: AlgoOrderRequest = {
      instId: params.instId,
      tdMode: params.tdMode,
      side: params.side,
      ordType: params.ordType,
      sz: params.sz,
      posSide: params.posSide,
      reduceOnly: params.reduceOnly,
      tpTriggerPx: params.tpTriggerPx,
      tpOrdPx: params.tpOrdPx,
      tpTriggerPxType: params.tpTriggerPxType,
      slTriggerPx: params.slTriggerPx,
      slOrdPx: params.slOrdPx,
      slTriggerPxType: params.slTriggerPxType
    };

    const [result] = await this.client.placeAlgoOrder(request);
    return normalizeAlgoResult(result);
  }

  async cancelAlgoOrders(
    orders: Array<{ algoId: string; instId: string; ordType?: "conditional" | "oco" }>
  ): Promise<void> {
    if (orders.length === 0) {
      return;
    }

    await this.client.cancelAlgoOrder(orders as CancelAlgoOrderRequest[]);
  }

  async setLeverage(params: OkxLeverageParams): Promise<void> {
    await this.client.setLeverage({
      instId: params.instId,
      lever: params.lever,
      mgnMode: params.mgnMode,
      posSide: params.posSide
    });
  }

  async ensurePositionMode(mode: "net" | "long_short"): Promise<void> {
    const target: PositionMode = mode === "long_short" ? "long_short_mode" : "net_mode";
    if (this.positionMode === target) {
      return;
    }

    try {
      await this.client.setPositionMode({ posMode: target });
      this.positionMode = target;
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes("Same mode")) {
        this.positionMode = target;
        return;
      }
      throw error;
    }
  }

  async getInstrument(instId: string, instType: string): Promise<OkxInstrumentMeta> {
    const cacheKey = `${instType}_${instId}`;
    const cached = this.instrumentCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const instruments = (await this.client.getInstruments({
      instType: instType as InstrumentType,
      instId
    })) as Instrument[];

    const instrument = instruments?.find((item) => item.instId === instId);
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

  async getAccountBalance(): Promise<any[]> {
    const balances = await this.client.getBalance();
    return Array.isArray(balances) ? balances : [];
  }

  async getPositions(instId?: string): Promise<any[]> {
    const params = instId ? { instId } : undefined;
    const positions = await this.client.getPositions(params);
    return Array.isArray(positions) ? positions : [];
  }

  async getTicker(instId: string): Promise<number> {
    const tickers = (await this.client.getTicker({ instId })) as Ticker[];
    const record: Ticker | undefined = Array.isArray(tickers) ? tickers[0] : undefined;
    const price = record?.last ?? record?.askPx ?? record?.bidPx;
    const num = parseFloat(price ?? "0");
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`Failed to fetch ticker for ${instId}`);
    }
    return num;
  }
}

function normalizeOrderResult(result?: OrderResult): OkxOrderResponse {
  if (!result) {
    return {
      ordId: "",
      sCode: "Unknown",
      sMsg: "Empty response from OKX submitOrder"
    };
  }

  return {
    ordId: result.ordId,
    clOrdId: result.clOrdId,
    sCode: result.sCode,
    sMsg: result.sMsg
  };
}

function normalizeAlgoResult(result?: AlgoOrderResult): OkxAlgoOrderResponse {
  if (!result) {
    return {
      algoId: "",
      sCode: "Unknown",
      sMsg: "Empty response from OKX placeAlgoOrder"
    };
  }

  return {
    algoId: result.algoId,
    sCode: result.sCode,
    sMsg: result.sMsg
  };
}

function extractErrorMessage(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object") {
    const maybeMsg = (error as { msg?: unknown; message?: unknown }).msg ?? (error as {
      message?: unknown;
    }).message;
    if (maybeMsg !== undefined) {
      return String(maybeMsg);
    }
  }

  return String(error);
}
