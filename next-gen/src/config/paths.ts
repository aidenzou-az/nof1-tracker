import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const PROJECT_ROOT = resolve(__dirname, "..");
const DATA_ROOT = resolve(PROJECT_ROOT, "..", "data", "next-gen");
const RAW_SIGNAL_LOG = resolve(DATA_ROOT, "raw-signals.ndjson");
const WATCH_STATE_FILE = resolve(DATA_ROOT, "watch-state.json");

export const paths = {
  projectRoot: PROJECT_ROOT,
  dataRoot: DATA_ROOT,
  rawSignalLog: RAW_SIGNAL_LOG,
  watchState: WATCH_STATE_FILE
};

export function ensureDataRoot(): void {
  mkdirSync(DATA_ROOT, { recursive: true });
}
