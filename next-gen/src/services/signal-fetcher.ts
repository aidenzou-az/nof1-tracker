import { AgentAccount } from "../types/nof1";
import https from "node:https";
import { IncomingMessage } from "node:http";

export interface FetchSignalsOptions {
  baseUrl?: string;
  marker?: number;
  agents?: string[];
}

const DEFAULT_BASE_URL = "https://nof1.ai/api";

export async function fetchAgentAccounts(options: FetchSignalsOptions = {}): Promise<AgentAccount[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const marker = options.marker;

  const url = buildAccountTotalsUrl(baseUrl, marker);

  const payload = (await requestJson(url)) as { accountTotals: AgentAccount[] };
  let accounts = payload.accountTotals ?? [];

  if (options.agents && options.agents.length > 0) {
    const targetAgents = new Set(options.agents.map((agent) => agent.trim()));
    accounts = accounts.filter((account) => targetAgents.has(account.model_id));
  }

  return accounts;
}

function requestJson(url: URL): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res: IncomingMessage) => {
      const { statusCode } = res;
      const chunks: Buffer[] = [];

      res.on("data", (chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });

      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");

        if (statusCode && statusCode >= 200 && statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Failed to parse response JSON: ${(error as Error).message}`));
          }
        } else {
          reject(new Error(`HTTP ${statusCode ?? "unknown"} - ${body}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function buildAccountTotalsUrl(base: string, marker?: number): URL {
  const baseUrl = new URL(base);
  const path = baseUrl.pathname.endsWith("/") ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
  baseUrl.pathname = `${path}/account-totals`;

  if (marker !== undefined) {
    baseUrl.searchParams.set("lastHourlyMarker", String(marker));
  }

  return baseUrl;
}
