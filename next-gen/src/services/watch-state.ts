import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SignalBundle } from "./signal-bundler";
import { ensureDataRoot, paths } from "../config/paths";

export interface WatchStatePosition {
  entryOid: number;
  signalMarker?: number;
  updatedAt: string;
}

export interface WatchStateAgent {
  positions: Record<string, WatchStatePosition>;
}

export interface WatchState {
  agents: Record<string, WatchStateAgent>;
}

interface FilterResult {
  bundles: SignalBundle[];
  nextState: WatchState;
  skipped: number;
}

const DEFAULT_STATE: WatchState = { agents: {} };

export function loadWatchState(filePath = paths.watchState): WatchState {
  ensureDataRoot();
  if (!existsSync(filePath)) {
    return { agents: {} };
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as WatchState;
    if (!parsed || typeof parsed !== "object" || !parsed.agents) {
      return { agents: {} };
    }
    return parsed;
  } catch (error) {
    console.warn(`Failed to parse watch state '${filePath}': ${(error as Error).message}`);
    return { agents: {} };
  }
}

export function saveWatchState(state: WatchState, filePath = paths.watchState): void {
  ensureDataRoot();
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function clearWatchState(filePath = paths.watchState): void {
  ensureDataRoot();
  writeFileSync(filePath, JSON.stringify(DEFAULT_STATE, null, 2), "utf8");
}

export function filterBundlesWithState(
  bundles: SignalBundle[],
  state: WatchState
): FilterResult {
  const fresh: SignalBundle[] = [];
  const nextState: WatchState = {
    agents: { ...state.agents }
  };
  let skipped = 0;

  for (const bundle of bundles) {
    const agentId = bundle.normalized.agentId;
    const symbol = bundle.normalized.symbol;
    const entryOid = bundle.normalized.entryOid;
    const marker = bundle.normalized.signalMarker;

    if (!nextState.agents[agentId]) {
      nextState.agents[agentId] = { positions: {} };
    }

    const agentState = nextState.agents[agentId];
    const positionState = agentState.positions[symbol];

    if (positionState && positionState.entryOid === entryOid) {
      skipped += 1;
      continue;
    }

    fresh.push(bundle);
    agentState.positions[symbol] = {
      entryOid,
      signalMarker: marker,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    bundles: fresh,
    nextState,
    skipped
  };
}
