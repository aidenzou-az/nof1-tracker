# Nof1 Tracker – Next Generation

这个目录用于重构跟单管线，目标是在保持原仓库代码不变的情况下，逐阶段实现事件驱动的信号处理框架。

## 阶段规划

1. **信号采集与日志化（进行中）**  
   - 已提供 `record` 命令：从 JSON 输入解析 agent 仓位，生成标准化信号并写入 `data/next-gen/raw-signals.ndjson`。
   - 支持 `--dry-run` 预览输出，后续阶段会在此基础上扩展 Guard 与决策记录。
2. **Guard 层雏形**
   - 已实现价格容差 (`PriceGuard`) 与信号时效 (`AgeGuard`) 校验，可通过 CLI/配置文件调整阈值。
3. **Decision 结构 & 统一落库**  
   - 新增 `Decision` 日志：Guard 判定后会生成 `EXECUTE / SKIP / SIMULATE` 决策并写入 `data/next-gen/decisions.ndjson`。
4. **Guard 插件化 & 扩展（完成）**  
   - 支持通过 `--guards` 或 JSON 配置选择 Guard，新增 `NotionalGuard` 控制单笔名义价值，并提供 `audit` 命令快速审计失败原因。
5. **事件流化 & 回放工具（完成）**  
   - `raw-signals.ndjson` 作为事件总线，`record`/`fetch` 写入，`replay` 可按 Guard 配置重新跑并选择性落库或执行。

每个阶段完成后都会在本目录内追加文档与命令说明，可与原项目并行使用。

## 当前可用命令

```bash
# 在 next-gen 目录下安装依赖
npm install

# Dry run：从示例 JSON 生成标准化信号但不写入文件
npm run dev -- record --input ./examples/account.json --dry-run --verbose --price-tolerance 1 --max-age 120 --max-notional 500

# 实际记录信号
npm run dev -- record --input ./examples/account.json --source manual --max-notional 800

# 审计最近的决策，查看 PriceGuard 拒绝情况
npm run dev -- audit --guard-filter PriceGuard

# 重放历史信号（不写入决策）
npm run dev -- replay --guards price,notional --max-notional 600 --simulate --verbose

# 重放并将新的决策写回日志
npm run dev -- replay --guards-config ./guards.json --save-decisions

# 每90秒抓取 deepseek 信号并执行 Guard（模拟模式）
npm run dev -- watch --agents deepseek-chat-v3.1 --interval 90 --guards-config ./guards.json --simulate

可选参数说明：

- `--price-tolerance <pct>`：价格容差（默认 1%）。
- `--max-age <seconds>`：最大信号延迟（配置后启用 `AgeGuard`）。
- `--max-notional <amount>`：允许的最大名义价值（启用 `NotionalGuard`）。
- `--guards g1,g2`：自定义 Guard 顺序，如 `price,age,notional`。
- `--guards-config path`：从 JSON 加载 Guard 配置（示例见下文）。
- `--simulate`：强制决策为 `SIMULATE`（即使 Guard 通过也不会落为 EXECUTE）。
- `--execute`：在 Guard 全通过时调用真实执行器（默认关闭）。
- `--exchange <name>`：选择执行器（`simulator`、`binance`、`okx` / 默认 simulator）。
- `--save-decisions`（仅 `replay`）：将重放后的决策写入 `decisions.ndjson`。
- `--verbose`：输出所有 Guard 的 PASS/FAIL 详情（不加时只显示失败项）。

`audit` 命令参数：

- `--guard-filter <name>`：仅查看指定 Guard 失败的决策。
- `--action-filter <EXECUTE|SKIP|SIMULATE>`：按最终动作筛选。
- `--reason-code <code>`：按 `reasonCode` 精确过滤。

`fetch` 命令额外支持：

- `--agents a1,a2`：仅抓取指定 Agent（按 `model_id`）。
- `--marker <value>`：指定 `lastHourlyMarker`（整数）。
- `--api-base <url>`：自定义 API Base URL。
  - 默认使用 `https://nof1.ai/api`。如网络受限，可通过此参数或 `NOF1_API_BASE_URL` 环境变量指定镜像地址。

`watch` 命令继承 `fetch` 所有参数，并额外提供 `--interval <seconds>` 控制轮询频率（默认 60 秒）。

`replay` 命令继承上述 Guard 参数，并额外提供 `--save-decisions`。默认仅打印结果，不改动决策日志。

### Guard 配置文件示例

```json
{
  "guards": ["price", "age", "notional"],
  "params": {
    "priceTolerance": 0.8,
    "maxAge": 90,
    "maxNotional": 600
  }
}
```

保存为 `guards.json` 后，可通过 `--guards-config ./guards.json` 加载；命令行参数会覆盖配置文件中的同名参数。
```

默认将日志写入 `next-gen/data/next-gen/` 目录（`raw-signals.ndjson`、`decisions.ndjson`），文件采用 NDJSON（每行一个 JSON）便于后续回放与审计。

### Guard 快速参考

- **PriceGuard**：比较 `entryPrice` 与当前价，超出容差（默认 1%）即拒绝。
- **AgeGuard**：超出 `maxAge` 秒视为信号过期（未设置则不启用）。
- **NotionalGuard**：`quantity × entryPrice` 超过设定的最大名义价值时拒绝。该值可按账户总资金或单笔最大风险设定，例如账户 10,000 USDT 时可设为 500～1000。

### 执行器说明

- `simulator`：默认执行器，只打印模拟执行结果。
- `binance`：需要 `BINANCE_API_KEY/BINANCE_API_SECRET`（可选 `BINANCE_TESTNET=true` 指向测试网）。会在下单前拉取账户余额、持仓与最新价格；自动根据现有仓位决定是否开启 `reduceOnly`/`closePosition`；对新开仓做保证金校验；根据信号里的 `exit_plan` 自动挂出 `TAKE_PROFIT_MARKET` 和 `STOP_MARKET` 保护单。
- `okx`：需要 `OKX_API_KEY/OKX_API_SECRET/OKX_API_PASS`（可选 `OKX_SIMULATED=true` 启用纸币交易）。底层基于官方维护的 [`okx-api`](https://www.npmjs.com/package/okx-api) SDK，与官方 REST API 同步更新。执行时会查询合约元信息、校准张数；在 `net` 与 `long_short` 模式下自动识别平仓/反手需求并设置 `reduceOnly`；按照账户可用资金校验保证金；若信号带有止盈止损，则会通过 `order-algo` 创建一笔联合 TP/SL 保护单。

环境变量（Binance）：

- `BINANCE_API_KEY` / `BINANCE_API_SECRET`：必填。
- `BINANCE_TESTNET=true`：启用测试网（推荐先在测试网验证）。
- `BINANCE_DEFAULT_LEVERAGE=<整数>`：每次下单前设置的杠杆（可选）。
- `BINANCE_MARGIN_TYPE=CROSSED|ISOLATED`：调整保证金模式，默认 `CROSSED`。
- `BINANCE_FORCE_REDUCE_ONLY=true`：下单时开启 `reduceOnly`，用于平仓/退出场景。

环境变量（OKX）：

- `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASS`（或 `OKX_API_PASSPHRASE`）：必填。
- `OKX_SIMULATED=true`：在纸币环境下测试。
- `OKX_API_BASE`：自定义 API Base URL（默认 `https://www.okx.com`）。
- `OKX_MARGIN_MODE=cross|isolated`：订单 `tdMode`，默认 `cross`。
- `OKX_LEVERAGE=<整数>`：下单前调用设置杠杆。
- `OKX_FORCE_REDUCE_ONLY=true`：强制 `reduceOnly`。
- `OKX_POS_MODE=net|long_short`：指定持仓模式，`long_short` 时会自动填充 `posSide`。
- `OKX_INST_ID=<instId>`：直接指定 instId（例如 `BTC-USDT-SWAP`）。未配置时默认把信号符号映射为 `<symbol>-USDT-SWAP`。
- `OKX_INSTRUMENT_SUFFIX`：自定义 instId 后缀（默认 `-USDT-SWAP`）。
- `OKX_INST_TYPE`：instrument 类型（默认 `SWAP`）。
- `OKX_FORCE_REDUCE_ONLY=true` 与 `--simulate/--execute` 配合，可实现换仓/平仓逻辑；程序会打印可用资金、名义价值和所需保证金，低于阈值会自动拒单。
