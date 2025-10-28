#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentAccount, Nof1Response, Position } from "./types/nof1";
import { buildSignal } from "./services/signal-normalizer";
import { buildRecord, RawSignalStore } from "./services/raw-signal-store";
import { NormalizedSignal, RawSignalRecord } from "./types/signal";
import { Guard } from "./guards/types";
import { runGuards, GuardEvaluation } from "./guards/runner";
import { PriceGuard } from "./guards/price-guard";
import { AgeGuard } from "./guards/age-guard";
import { NotionalGuard } from "./guards/notional-guard";
import { Decision, DecisionAction } from "./types/decision";
import { DecisionStore } from "./services/decision-store";
import { fetchAgentAccounts } from "./services/signal-fetcher";
import { createExchangeExecutor } from "./exchange/factory";

interface CliOptions {
  input?: string;
  source?: string;
  dryRun?: boolean;
  verbose?: boolean;
  priceTolerance?: number;
  maxAge?: number;
  simulate?: boolean;
  maxNotional?: number;
  guards?: string[];
  guardsConfigPath?: string;
  auditGuard?: string;
  auditAction?: DecisionAction;
  auditReasonCode?: string;
  saveDecisions?: boolean;
  execute?: boolean;
  exchange?: string;
  agents?: string[];
  marker?: number;
  apiBase?: string;
  interval?: number;
}

interface SignalBundle {
  normalized: NormalizedSignal;
  raw: Record<string, unknown>;
  meta: RawSignalRecord["meta"];
}

interface ParsedCli {
  command: string | undefined;
  options: CliOptions;
}

async function main(): Promise<void> {
  const { command, options } = parseCli(process.argv.slice(2));

  switch (command) {
    case "record":
      await handleRecord(options);
      break;
    case "fetch":
      await handleFetch(options);
      break;
    case "watch":
      await handleWatch(options);
      break;
    case "audit":
      await handleAudit(options);
      break;
    case "replay":
      await handleReplay(options);
      break;
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function handleRecord(options: CliOptions): Promise<void> {
  if (!options.input) {
    console.error("Missing required option: --input <file>");
    process.exitCode = 1;
    return;
  }

  const inputPath = resolve(process.cwd(), options.input);
  let parsedPayload: Nof1Response | AgentAccount | AgentAccount[];

  try {
    const rawContent = readFileSync(inputPath, "utf8");
    parsedPayload = JSON.parse(rawContent);
  } catch (error) {
    console.error(`Failed to read or parse ${inputPath}:`, (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const accounts = normalizeToAccounts(parsedPayload);
  if (accounts.length === 0) {
    console.log("No positions detected in input. Nothing to record.");
    return;
  }

  const guardConfig = options.guardsConfigPath ? loadGuardConfig(options.guardsConfigPath) : undefined;
  const guardPipeline = createGuardPipeline(options, guardConfig);
  const bundles = buildBundlesFromAccounts(accounts, options.source ?? "file", inputPath);
  const { evaluations, decisions, rawRecords } = processSignalBundles(bundles, guardPipeline, options);

  const shouldPersist = !options.dryRun;

  if (options.dryRun) {
    console.log(`Dry run: would record ${rawRecords.length} signal(s) from ${accounts.length} agent(s).`);
    rawRecords.forEach((record) => console.log(JSON.stringify(record, null, 2)));
  } else {
    const store = new RawSignalStore();
    store.appendMany(rawRecords);
    console.log(`✅ Recorded ${rawRecords.length} signal(s) to raw-signal log.`);
  }

  logGuardEvaluations(evaluations, options.verbose ?? false);
  logDecisions(decisions);

  await executeDecisions(decisions, options);
  await persistDecisions(decisions, shouldPersist, `💾 Saved ${decisions.length} decision(s) to decisions.ndjson`);
}

async function handleFetch(options: CliOptions): Promise<void> {
  let accounts: AgentAccount[] = [];

  if (options.input) {
    const inputPath = resolve(process.cwd(), options.input);
    try {
      const rawContent = readFileSync(inputPath, "utf8");
      const parsed = JSON.parse(rawContent) as Nof1Response | AgentAccount | AgentAccount[];
      accounts = normalizeToAccounts(parsed);
    } catch (error) {
      console.error(`Failed to read or parse ${options.input}:`, (error as Error).message);
      process.exitCode = 1;
      return;
    }
  } else {
    try {
      accounts = await fetchAgentAccounts({
        baseUrl: options.apiBase,
        marker: options.marker,
        agents: options.agents
      });
    } catch (error) {
      console.error(`Failed to fetch signals: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (accounts.length === 0) {
    console.log("No accounts returned. Nothing to process.");
    return;
  }

  const guardConfig = options.guardsConfigPath ? loadGuardConfig(options.guardsConfigPath) : undefined;
  const guardPipeline = createGuardPipeline(options, guardConfig);
  const bundles = buildBundlesFromAccounts(accounts, options.source ?? "nof1-api", options.input);
  const { evaluations, decisions, rawRecords } = processSignalBundles(bundles, guardPipeline, options);

  const shouldPersist = !options.dryRun;

  if (options.dryRun) {
    console.log(`Dry run: would record ${rawRecords.length} signal(s).`);
    rawRecords.forEach((record) => console.log(JSON.stringify(record, null, 2)));
  } else {
    const store = new RawSignalStore();
    store.appendMany(rawRecords);
    console.log(`✅ Fetched and recorded ${rawRecords.length} signal(s) to raw-signal log.`);
  }

  logGuardEvaluations(evaluations, options.verbose ?? false);
  logDecisions(decisions);

  await executeDecisions(decisions, options);
  await persistDecisions(decisions, shouldPersist, `💾 Saved ${decisions.length} decision(s) to decisions.ndjson`);
}

async function handleWatch(options: CliOptions): Promise<void> {
  const intervalSeconds = options.interval ?? 60;
  if (intervalSeconds <= 0) {
    console.error("Interval must be greater than zero seconds.");
    process.exitCode = 1;
    return;
  }

  console.log(`📡 Starting watch loop (interval ${intervalSeconds}s)`);
  let iteration = 0;
  while (true) {
    iteration += 1;
    console.log(`\n--- Watch iteration #${iteration} ---`);
    try {
      await handleFetch({ ...options, dryRun: options.dryRun });
    } catch (error) {
      console.error(`Watch iteration failed: ${(error as Error).message}`);
    }

    await delay(intervalSeconds * 1000);
  }
}

async function handleReplay(options: CliOptions): Promise<void> {
  const rawStore = new RawSignalStore();
  const events = rawStore.readAll();

  if (events.length === 0) {
    console.log("No raw signals recorded yet. Run the record command first.");
    return;
  }

  const guardConfig = options.guardsConfigPath ? loadGuardConfig(options.guardsConfigPath) : undefined;
  const guardPipeline = createGuardPipeline(options, guardConfig);

  const bundles: SignalBundle[] = events.map((event) => ({
    normalized: event.normalized,
    raw: event.raw,
    meta: event.meta
  }));

  const { evaluations, decisions } = processSignalBundles(bundles, guardPipeline, options);

  logGuardEvaluations(evaluations, options.verbose ?? false);
  logDecisions(decisions);

  await executeDecisions(decisions, options);
  if (options.saveDecisions) {
    await persistDecisions(decisions, true, `💾 Saved ${decisions.length} replay decision(s) to decisions.ndjson`);
  }
  console.log(`Replay complete: processed ${events.length} signal(s).`);
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

  throw new Error("Unsupported payload structure for agent accounts.");
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

function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  const options: CliOptions = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--input":
        options.input = rest[++i];
        break;
      case "--source":
        options.source = rest[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--price-tolerance":
        options.priceTolerance = parseFloat(rest[++i]);
        if (Number.isNaN(options.priceTolerance)) {
          console.warn("Invalid value for --price-tolerance; ignoring.");
          options.priceTolerance = undefined;
        }
        break;
      case "--max-age": {
        const value = parseFloat(rest[++i]);
        if (Number.isNaN(value)) {
          console.warn("Invalid value for --max-age; ignoring.");
        } else {
          options.maxAge = value;
        }
        break;
      }
      case "--max-notional": {
        const value = parseFloat(rest[++i]);
        if (Number.isNaN(value)) {
          console.warn("Invalid value for --max-notional; ignoring.");
        } else {
          options.maxNotional = value;
        }
        break;
      }
      case "--execute":
        options.execute = true;
        break;
      case "--exchange":
        options.exchange = rest[++i];
        break;
      case "--simulate":
        options.simulate = true;
        break;
      case "--guards":
        options.guards = (rest[++i] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        break;
      case "--guards-config":
        options.guardsConfigPath = rest[++i];
        break;
      case "--guard-filter":
        options.auditGuard = rest[++i];
        break;
      case "--action-filter": {
        const value = rest[++i]?.toUpperCase();
        if (value === "EXECUTE" || value === "SKIP" || value === "SIMULATE") {
          options.auditAction = value as DecisionAction;
        } else {
          console.warn("Invalid value for --action-filter; ignoring.");
        }
        break;
      }
      case "--reason-code":
        options.auditReasonCode = rest[++i];
        break;
      case "--save-decisions":
        options.saveDecisions = true;
        break;
      case "--agents":
        options.agents = (rest[++i] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        break;
      case "--marker": {
        const value = parseInt(rest[++i] ?? "", 10);
        if (Number.isNaN(value)) {
          console.warn("Invalid value for --marker; ignoring.");
        } else {
          options.marker = value;
        }
        break;
      }
      case "--api-base":
        options.apiBase = rest[++i];
        break;
      case "--interval": {
        const value = parseFloat(rest[++i] ?? "");
        if (Number.isNaN(value) || value <= 0) {
          console.warn("Invalid value for --interval; ignoring.");
        } else {
          options.interval = value;
        }
        break;
      }
      default:
        console.warn(`Unknown option ignored: ${arg}`);
    }
  }

  return { command, options };
}

function printHelp(): void {
  console.log(`
Usage: node dist/index.js <command> [options]

Commands:
  record --input <file> [--source name] [--dry-run] [--verbose]
         [--price-tolerance pct] [--max-age seconds] [--max-notional value]
         [--guards g1,g2] [--guards-config path] [--simulate]
         [--execute] [--exchange name]
         记录原始 agent 信号到日志并运行 Guard/生成决策

  fetch [--agents a1,a2] [--marker value] [--api-base url]
        [--price-tolerance pct] [--max-age seconds] [--max-notional value]
        [--guards g1,g2] [--guards-config path] [--simulate]
        [--execute] [--exchange name]
        从 nof1 API 抓取最新信号并运行 Guard/生成决策

  watch [--interval seconds] [其余参数同 fetch]
        定时轮询 nof1 API 并运行 Guard/执行（默认每60秒）

  replay [--guards g1,g2] [--guards-config path]
         [--price-tolerance pct] [--max-age seconds] [--max-notional value]
         [--simulate] [--save-decisions] [--verbose]
         基于 raw-signals.ndjson 重新跑 Guard/生成决策

  audit [--guard-filter name] [--action-filter type] [--reason-code code]
         汇总决策日志

  help                                                显示帮助

Examples:
  npm run dev -- record --input ./examples/account.json --dry-run --verbose --price-tolerance 0.8
  npm run dev -- record --input ./examples/account.json --source manual --max-age 120 --max-notional 500 --simulate
  npm run dev -- fetch --agents gpt-5 --max-age 120 --guards-config ./guards.json
  npm run dev -- watch --agents deepseek-chat-v3.1 --interval 90 --guards-config ./guards.json
  npm run dev -- replay --guards price,notional --max-notional 600 --simulate --verbose
  npm run dev -- audit --guard-filter PriceGuard --action-filter SKIP
`);
}

interface GuardConfigFile {
  guards?: string[];
  params?: {
    priceTolerance?: number;
    maxAge?: number;
    maxNotional?: number;
  };
}

function createGuardPipeline(options: CliOptions, config?: GuardConfigFile): Guard[] {
  const guardNames = resolveGuardNames(options, config);
  const params = resolveGuardParams(options, config);

  const guards: Guard[] = [];

  for (const name of guardNames) {
    switch (name) {
      case "price":
        guards.push(new PriceGuard({ tolerancePercentage: params.priceTolerance ?? 1 }));
        break;
      case "age":
        if (params.maxAge !== undefined) {
          guards.push(new AgeGuard({ maxAgeSeconds: params.maxAge }));
        } else {
          console.warn("AgeGuard requires max-age parameter; skipping.");
        }
        break;
      case "notional":
        if (params.maxNotional !== undefined) {
          guards.push(new NotionalGuard({ maxNotional: params.maxNotional }));
        } else {
          console.warn("NotionalGuard requires max-notional parameter; skipping.");
        }
        break;
      case "noop":
        break;
      default:
        console.warn(`Unknown guard '${name}' ignored.`);
    }
  }

  return guards;
}

function logGuardEvaluations(
  entries: Array<{ evaluation: GuardEvaluation }>,
  verbose: boolean
): void {
  for (const { evaluation } of entries) {
    if (evaluation.results.length === 0) {
      continue;
    }

    const interestingResults = evaluation.results.filter((result) => verbose || !result.passed);
    if (interestingResults.length === 0) {
      continue;
    }

    const header = `${evaluation.signal.agentId} ${evaluation.signal.symbol}`;
    console.log(`Guard results for ${header}:`);
    for (const result of interestingResults) {
      const status = result.passed ? "PASS" : "FAIL";
      const reason = result.reason ? ` - ${result.reason}` : "";
      console.log(`  [${status}] ${result.guard}${reason}`);
    }
  }
}

function buildDecision(
  bundle: SignalBundle,
  evaluation: GuardEvaluation,
  simulate: boolean
): Decision {
  const { normalized, raw, meta } = bundle;
  const baseAction: DecisionAction = evaluation.passed ? "EXECUTE" : "SKIP";
  const action: DecisionAction = simulate ? "SIMULATE" : baseAction;
  const failingGuard = evaluation.results.find((result) => !result.passed);
  const reasonCode = failingGuard
    ? `${failingGuard.guard}_FAIL`
    : simulate
    ? "SIMULATED"
    : "GUARDS_PASS";

  return {
    id: generateDecisionId(normalized),
    createdAt: new Date().toISOString(),
    action,
    reasonCode,
    reason: failingGuard?.reason,
    signal: normalized,
    guards: evaluation.results.map(({ guard, passed, reason, details }) => ({
      guard,
      passed,
      reason,
      details
    })),
    raw,
    meta
  };
}

function generateDecisionId(signal: ReturnType<typeof buildSignal>): string {
  return `${signal.agentId}-${signal.symbol}-${signal.entryOid}-${Date.now()}`;
}

function logDecisions(decisions: Decision[]): void {
  for (const decision of decisions) {
    const base = `Decision: ${decision.action} (${decision.reasonCode}) for ${decision.signal.agentId} ${decision.signal.symbol}`;
    console.log(base);
    if (decision.reason) {
      console.log(`  Reason: ${decision.reason}`);
    }
  }
}

function buildBundlesFromAccounts(accounts: AgentAccount[], source: string, inputFile?: string): SignalBundle[] {
  const bundles: SignalBundle[] = [];

  for (const account of accounts) {
    for (const position of Object.values(account.positions)) {
      const normalized = buildSignal(account, position, new Date().toISOString());
      bundles.push({
        normalized,
        raw: {
          accountId: account.id,
          modelId: account.model_id,
          position
        },
        meta: {
          source,
          inputFile
        }
      });
    }
  }

  return bundles;
}

function processSignalBundles(
  bundles: SignalBundle[],
  guardPipeline: Guard[],
  options: CliOptions
): {
  evaluations: Array<{ evaluation: GuardEvaluation }>;
  decisions: Decision[];
  rawRecords: RawSignalRecord[];
} {
  const evaluations: Array<{ evaluation: GuardEvaluation }> = [];
  const decisions: Decision[] = [];
  const rawRecords: RawSignalRecord[] = [];

  for (const bundle of bundles) {
    const evaluation = runGuards(bundle.normalized, {
      now: new Date(),
      rawPosition: extractPosition(bundle.raw),
      meta: bundle.meta
    }, guardPipeline);

    evaluations.push({ evaluation });

    const decision = buildDecision(bundle, evaluation, options.simulate ?? false);
    decisions.push(decision);

    const guardPass = decision.guards.every((guard) => guard.passed);
    rawRecords.push(
      buildRecord(bundle.normalized, bundle.raw, bundle.meta, decision.guards, guardPass)
    );
  }

  return { evaluations, decisions, rawRecords };
}

async function persistDecisions(decisions: Decision[], shouldPersist: boolean, label?: string): Promise<void> {
  if (!shouldPersist || decisions.length === 0) {
    return;
  }

  const decisionStore = new DecisionStore();
  decisions.forEach((decision) => decisionStore.append(decision));

  if (label) {
    console.log(label);
  } else {
    console.log(`💾 Saved ${decisions.length} decision(s) to decisions.ndjson`);
  }
}

async function executeDecisions(decisions: Decision[], options: CliOptions): Promise<void> {
  if (!options.execute || options.simulate) {
    return;
  }

  const executor = createExchangeExecutor(options.exchange);
  const executable = decisions.filter((decision) => decision.action === "EXECUTE");

  if (executable.length === 0) {
    console.log("No executable decisions detected (all skipped or simulated).");
    return;
  }

  console.log(`🚀 Executing ${executable.length} decision(s) on ${executor.name} exchange`);

  const executedDecisions: Decision[] = [];
  for (const decision of executable) {
    const executedAt = new Date().toISOString();
    try {
      const report = await executor.execute(decision);
      const status = report.success ? "SUCCESS" : "FAILED";
      console.log(`  [${status}] Decision ${decision.id} - ${report.message ?? ""}`);

      decision.execution = {
        exchange: executor.name,
        executedAt,
        ...report
      };
    } catch (error) {
      const message = (error as Error).message;
      console.error(`  [ERROR] Decision ${decision.id} execution failed: ${message}`);

      decision.execution = {
        exchange: executor.name,
        executedAt,
        decisionId: decision.id,
        success: false,
        message: `Execution threw error: ${message}`
      };
    }

    executedDecisions.push(decision);
  }

  if (executedDecisions.length > 0) {
    const successes = executedDecisions.filter((item) => item.execution?.success);
    const failures = executedDecisions.filter((item) => item.execution && !item.execution.success);

    console.log(
      `📊 Execution summary: ${successes.length}/${executedDecisions.length} successful, ${failures.length} failed.`
    );

    if (failures.length > 0) {
      console.log("⚠️ Failed executions:");
      failures.forEach((decision) => {
        const execution = decision.execution!;
        console.log(
          `  - ${decision.signal.agentId} ${decision.signal.symbol} (${decision.id}) :: ${execution.message ?? "No message"}`
        );
      });
    }
  }
}

function extractPosition(raw: Record<string, unknown>): Position | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const candidate = (raw as Record<string, unknown>).position;
  if (candidate && typeof candidate === "object") {
    return candidate as Position;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveGuardNames(options: CliOptions, config?: GuardConfigFile): string[] {
  if (options.guards && options.guards.length > 0) {
    return options.guards.map((name) => name.toLowerCase());
  }

  if (config?.guards && config.guards.length > 0) {
    return config.guards.map((name) => name.toLowerCase());
  }

  const names = new Set<string>(["price"]);
  const params = resolveGuardParams(options, config);
  if (params.maxAge !== undefined) names.add("age");
  if (params.maxNotional !== undefined) names.add("notional");
  return Array.from(names);
}

function resolveGuardParams(options: CliOptions, config?: GuardConfigFile) {
  return {
    priceTolerance: options.priceTolerance ?? config?.params?.priceTolerance,
    maxAge: options.maxAge ?? config?.params?.maxAge,
    maxNotional: options.maxNotional ?? config?.params?.maxNotional
  };
}

function loadGuardConfig(filePath: string): GuardConfigFile | undefined {
  try {
    const resolved = resolve(process.cwd(), filePath);
    const raw = readFileSync(resolved, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Failed to load guard config '${filePath}': ${(error as Error).message}`);
    return undefined;
  }
}

async function handleAudit(options: CliOptions): Promise<void> {
  const store = new DecisionStore();
  const decisions = store.readAll();

  if (decisions.length === 0) {
    console.log("No decisions recorded yet.");
    return;
  }

  const filtered = decisions.filter((decision) => matchesFilters(decision, options));
  printDecisionSummary(decisions, filtered, options);
}

function matchesFilters(decision: Decision, options: CliOptions): boolean {
  if (options.auditAction && decision.action !== options.auditAction) {
    return false;
  }

  if (options.auditReasonCode && decision.reasonCode !== options.auditReasonCode) {
    return false;
  }

  if (options.auditGuard) {
    const guard = decision.guards.find((g) => g.guard.toLowerCase() === options.auditGuard!.toLowerCase());
    if (!guard || guard.passed) {
      return false;
    }
  }

  return true;
}

function printDecisionSummary(all: Decision[], filtered: Decision[], options: CliOptions): void {
  console.log(`Decisions recorded: ${all.length}`);
  const actionCounts = countBy(all, (decision) => decision.action);
  console.log("Action breakdown:");
  for (const [action, count] of actionCounts.entries()) {
    console.log(`  ${action}: ${count}`);
  }

  const executed = all.filter((decision) => decision.execution);
  if (executed.length > 0) {
    const successful = executed.filter((decision) => decision.execution?.success);
    const failed = executed.filter((decision) => decision.execution && !decision.execution.success);
    console.log(
      `Execution breakdown: total ${executed.length}, success ${successful.length}, failed ${failed.length}`
    );
    if (failed.length > 0) {
      console.log("  Failed executions:");
      failed.forEach((decision) => {
        const execution = decision.execution!;
        console.log(
          `    ${decision.signal.agentId} ${decision.signal.symbol} (${decision.id}) -> ${execution.message ?? "No message"}`
        );
      });
    }
  }

  const failureCounts = countGuardFailures(all);
  if (failureCounts.size > 0) {
    console.log("Guard failure breakdown:");
    for (const [guard, count] of failureCounts.entries()) {
      console.log(`  ${guard}: ${count}`);
    }
  }

  console.log("");
  console.log(`Filtered decisions (${filtered.length}):`);
  filtered.forEach((decision) => {
    console.log(`- ${decision.action} ${decision.signal.agentId} ${decision.signal.symbol} (${decision.reasonCode})`);
    for (const guard of decision.guards) {
      if (!guard.passed) {
        console.log(`    Guard ${guard.guard} failed: ${guard.reason ?? "No reason provided"}`);
      }
    }
    if (decision.execution) {
      const status = decision.execution.success ? "SUCCESS" : "FAILED";
      console.log(
        `    Execution [${status}] ${decision.execution.exchange} @ ${decision.execution.executedAt}${
          decision.execution.message ? ` :: ${decision.execution.message}` : ""
        }`
      );
    }
  });

  if (!options.auditGuard && !options.auditAction && !options.auditReasonCode) {
    console.log("\nUse --guard-filter/--action-filter/--reason-code for more targeted results.");
  }
}

function countBy<T>(items: T[], mapper: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = mapper(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function countGuardFailures(decisions: Decision[]): Map<string, number> {
  const failures: string[] = [];
  for (const decision of decisions) {
    decision.guards.forEach((guard) => {
      if (!guard.passed) {
        failures.push(guard.guard);
      }
    });
  }
  return countBy(failures, (guard) => guard);
}

void main().catch((error) => {
  console.error("Command failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
