import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { NormalizedSignal, RawSignalRecord, GuardSnapshot } from "../types/signal";
import { ensureDataRoot, paths } from "../config/paths";

export class RawSignalStore {
  private readonly filePath: string;

  constructor(filePath: string = paths.rawSignalLog) {
    ensureDataRoot();
    this.filePath = filePath;
    this.ensureFile();
  }

  publish(record: RawSignalRecord): void {
    this.append(record);
  }

  append(record: RawSignalRecord): void {
    const payload = JSON.stringify(record);
    appendFileSync(this.filePath, `${payload}\n`, "utf8");
  }

  appendMany(records: RawSignalRecord[]): void {
    if (records.length === 0) return;
    const payload = records.map((record) => JSON.stringify(record)).join("\n");
    appendFileSync(this.filePath, `${payload}\n`, "utf8");
  }

  readAll(): RawSignalRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const content = readFileSync(this.filePath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line));
  }

  private ensureFile(): void {
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf8");
    }
  }
}

export function buildRecord(
  normalized: NormalizedSignal,
  raw: Record<string, unknown>,
  meta: RawSignalRecord["meta"],
  guards?: GuardSnapshot[],
  guardPassed?: boolean
): RawSignalRecord {
  const receivedAt = new Date().toISOString();
  return {
    version: 1,
    normalized,
    raw,
    meta,
    receivedAt,
    guards,
    guardPassed
  };
}
