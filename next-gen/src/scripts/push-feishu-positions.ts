import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { AgentAccount, Nof1Response } from "../types/nof1";
import { fetchAgentAccounts } from "../services/signal-fetcher";
import { buildBundlesFromAccounts } from "../services/signal-bundler";
import { formatPositionSummary } from "../services/position-formatter";

interface ScriptOptions {
  agents?: string[];
  input?: string;
  apiBase?: string;
  marker?: number;
  heading?: string;
  source?: string;
  dryRun?: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
  const secret = process.env.FEISHU_SECRET;

  if ((!webhookUrl || !secret) && !options.dryRun) {
    throw new Error("Missing FEISHU_WEBHOOK_URL or FEISHU_SECRET environment variables");
  }

  let accounts: AgentAccount[] = [];

  if (options.input) {
    const inputPath = resolve(process.cwd(), options.input);
    const raw = readFileSync(inputPath, "utf8");
    const parsed = JSON.parse(raw) as Nof1Response | AgentAccount | AgentAccount[];
    accounts = normalizeToAccounts(parsed);
  } else {
    accounts = await fetchAgentAccounts({
      baseUrl: options.apiBase,
      agents: options.agents,
      marker: options.marker
    });
  }

  if (accounts.length === 0) {
    console.log("No accounts found; nothing to push.");
    return;
  }

  const bundles = buildBundlesFromAccounts(accounts, options.source ?? "feishu", options.input);
  const summary = formatPositionSummary(
    bundles,
    options.heading ?? `Agent Positions @ ${new Date().toISOString()}`
  ).replace(/^\n+/, "");

  if (options.dryRun || !webhookUrl || !secret) {
    console.log(summary);
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signKey = `${timestamp}\n${secret}`;
  const signature = crypto.createHmac("sha256", signKey).update("").digest("base64");

  const payload = {
    timestamp,
    sign: signature,
    msg_type: "text",
    content: {
      text: summary.trimEnd()
    }
  };

  await postJson(webhookUrl, payload);
  console.log("✅ Feishu notification sent.");
}

function parseArgs(args: string[]): ScriptOptions {
  const options: ScriptOptions = {
    agents: process.env.POSITIONS_AGENTS
      ? process.env.POSITIONS_AGENTS.split(",").map((item) => item.trim()).filter(Boolean)
      : undefined,
    apiBase: process.env.NOF1_API_BASE_URL,
    heading: process.env.POSITIONS_HEADING,
    source: process.env.POSITIONS_SOURCE,
    dryRun: process.env.DRY_RUN === "true"
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--agents": {
        const value = args[++i];
        if (value) {
          options.agents = value.split(",").map((item) => item.trim()).filter(Boolean);
        }
        break;
      }
      case "--input":
        options.input = args[++i];
        break;
      case "--api-base":
        options.apiBase = args[++i];
        break;
      case "--marker": {
        const value = args[++i];
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isNaN(parsed)) {
            options.marker = parsed;
          }
        }
        break;
      }
      case "--heading":
        options.heading = args[++i];
        break;
      case "--source":
        options.source = args[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        console.warn(`Unknown option ignored: ${arg}`);
    }
  }

  return options;
}

async function postJson(urlString: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const url = new URL(urlString);

  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
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
            resolve();
          } else {
            reject(
              new Error(
                `Feishu webhook error (${res.statusCode ?? "unknown"}): ${text || "<empty response>"}`
              )
            );
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function normalizeToAccounts(payload: Nof1Response | AgentAccount | AgentAccount[]): AgentAccount[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isNof1Response(payload)) {
    return payload.accountTotals;
  }

  if (isAgentAccount(payload)) {
    return [payload];
  }

  throw new Error("Unsupported payload structure for agent accounts");
}

function isNof1Response(value: unknown): value is Nof1Response {
  return Boolean(value && typeof value === "object" && "accountTotals" in (value as Record<string, unknown>));
}

function isAgentAccount(value: unknown): value is AgentAccount {
  return Boolean(
    value &&
      typeof value === "object" &&
      "model_id" in (value as Record<string, unknown>) &&
      "positions" in (value as Record<string, unknown>)
  );
}

void main().catch((error) => {
  console.error("Feishu push failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
