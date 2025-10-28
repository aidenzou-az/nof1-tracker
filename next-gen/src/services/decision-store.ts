import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decision } from "../types/decision";
import { ensureDataRoot, paths } from "../config/paths";

export class DecisionStore {
  private readonly filePath: string;

  constructor(filePath: string = resolve(paths.dataRoot, "decisions.ndjson")) {
    ensureDataRoot();
    this.filePath = filePath;
    this.ensureFile();
  }

  append(decision: Decision): void {
    appendFileSync(this.filePath, `${JSON.stringify(decision)}\n`, "utf8");
  }

  readAll(): Decision[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const content = readFileSync(this.filePath, "utf8").trim();
    if (!content) {
      return [];
    }
    return content.split("\n").map((line) => JSON.parse(line));
  }

  private ensureFile(): void {
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf8");
    }
  }
}
