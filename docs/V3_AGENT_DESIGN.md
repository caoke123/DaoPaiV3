# DaoPai Local Agent 设计

> 版本：v1.0（Phase 1 架构冻结草案）
> 适用范围：DaoPai V3 SaaS 方向
> 关联文档：V3_ARCHITECTURE.md / V3_DATA_MODEL.md / V3_CLOUD_PLATFORM.md

---

## 1. Agent 定位

DaoPai Local Agent 是安装在员工电脑上的本地执行端：

- Agent **只负责当前电脑的本地执行能力**。
- Agent **不负责**：租户管理、会员管理、云端任务中心 UI、跨设备调度。
- Agent **不存储**：云端业务数据副本（除本地临时日志和必要缓存外）。
- Agent **不直接暴露**：本地浏览器端口给云端。

Agent 是 V3 SaaS 架构中"执行层"的唯一入口，所有浏览器自动化动作都由 Agent 在本地发起。

---

## 2. 本地目录结构建议

```text
DaoPaiAgent/
  ├─ agent/                  # Agent 主程序代码
  ├─ runtime/
  │   └─ browser/            # Playwright 浏览器运行时数据
  ├─ config/
  │   └─ agent.json          # 本地配置
  ├─ logs/                   # 本地日志（最近 N 天）
  ├─ screenshots/            # 调试截图（默认关闭，临时保存）
  └─ cache/                  # 任务临时缓存
```

说明：

- `agent/` 是 Agent 主程序，由云端打包发布，员工电脑解压即用。
- `runtime/browser/` 存放 Playwright 浏览器二进制和用户数据目录。
- `config/agent.json` 是唯一配置入口，包含连接信息和身份信息。
- `logs/` 本地滚动保留，避免无限增长。
- `screenshots/` 仅调试模式启用，正常生产为空。
- `cache/` 用于任务执行过程中的临时文件，任务完成后清理。

---

## 3. 本地配置

`config/agent.json` 建议字段：

```json
{
  "cloudApiUrl": "https://api.daopai.example.com",
  "tenantId": "tnt_xxx",
  "siteId": "site_xxx",
  "workstationId": "ws_xxx",
  "workstationName": "天南大-前台01",
  "agentToken": "agt_xxxxxxxxxxxxxxxx",
  "screenshotEnabled": false,
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "logRetentionDays": 7
}
```

字段说明：

- `cloudApiUrl`：云端 API 基地址。
- `tenantId` / `siteId` / `workstationId`：Agent 身份三元组，首次绑定时由云端颁发。
- `workstationName`：本地显示名称，便于运维识别。
- `agentToken`：Agent 鉴权 Token，长期有效，可由云端撤销。
- `screenshotEnabled`：截图开关，默认 `false`。
- `pollIntervalMs`：任务轮询间隔，默认 5 秒。
- `heartbeatIntervalMs`：心跳上报间隔，默认 15 秒。
- `logRetentionDays`：本地日志保留天数，默认 7 天。

**安全要求**：

- `agent.json` 必须设置文件权限，仅当前用户可读写。
- `agentToken` 不在日志中明文输出。
- 配置文件不进入 Git 仓库。

---

## 4. 启动检查

Agent 启动后依次执行以下检查，任一失败则进入"降级模式"并上报云端：

1. **是否能连接云端**：HTTP 探测 `cloudApiUrl/health`。
2. **Token 是否有效**：调用 `GET /agent/me` 验证 `agentToken`。
3. **设备是否授权**：云端返回 workstation 状态必须为 `active`。
4. **浏览器环境是否存在**：检查 Playwright 浏览器是否已安装、可启动。
5. **本地配置是否完整**：`agent.json` 字段齐全且非空。
6. **本地窗口配置 / settings.json 是否可读取**：检查本地业务配置文件可访问。

检查失败处理：

- 网络/Token/授权类失败：进入等待重试，不上报无效心跳。
- 浏览器环境失败：上报 `workstation_status=browser_missing`，云端标记不可分配任务。
- 配置缺失：本地报错并退出，提示用户重新初始化。

---

## 5. 任务流程

Agent 主循环流程：

```text
Agent 启动
  ↓
启动检查（见第 4 节）
  ↓
注册 / 鉴权（首次或 Token 失效时）
  ↓
周期性上报心跳
  ↓
周期性轮询待执行任务
  ↓
领取任务（claim，数据库原子操作）
  ↓
本地执行（Playwright 自动化）
  ↓
阶段性回传进度 / 日志
  ↓
任务完成 → 回传结果（waybill_results）
  ↓
任务失败 → 回传错误日志 + 状态
  ↓
循环回到心跳 + 轮询
```

关键约束：

- **领取必须原子**：使用云端数据库原子操作，避免多设备重复领取。
- **执行中保持心跳**：执行期间心跳频率不低于平时，避免被误判离线。
- **结果回传幂等**：同一任务结果可多次回传，云端以最终一次为准。
- **失败不丢日志**：即使执行崩溃，已写入本地 `logs/` 的内容必须保留，下次启动可补传。

---

## 6. WebSocket 后续增强

第一版以 HTTP 轮询为主，后续引入 WebSocket 仅作为通知增强：

- **WebSocket 只做 `task_available` 通知**：云端有新任务时推送通知。
- **收到通知后仍通过 HTTP 拉取任务详情**：不通过 WebSocket 传输任务 payload。
- **断线后仍靠轮询兜底**：WebSocket 断开不影响 Agent 正常工作。
- **WebSocket 不替代数据库状态机**：任务状态、领取锁、完成时间全部以 PostgreSQL 为准。

设计原则：

> WebSocket 是"加速器"，不是"承重墙"。任何 WebSocket 故障都不应导致任务丢失或重复执行。

---

## 7. 截图

Agent 截图策略与云端保持一致：

- **默认关闭**：`screenshotEnabled=false`。
- **调试时本地临时保存**：保存到 `screenshots/` 目录，按任务 ID 分目录。
- **不默认上传云端**：避免占用带宽和云服务器磁盘。
- **未来可选对象存储**：如需远程排查，由云端配置对象存储（S3/R2/OSS），Agent 直传对象存储，云端只保存地址。
- **本地截图自动清理**：超过 `logRetentionDays` 的截图自动删除。

---

## 8. 与 V2 执行能力的关系

- V3 Local Agent 复用 V2 已稳定的浏览器自动化执行内核（Playwright 操作、窗口复用、会员会话保持）。
- V3 不修改 V2 代码，V2 继续独立运行。
- V3 Local Agent 是独立程序，不与 V2 共享进程、配置、端口。
- V3 Local Agent 的执行内核可从 V2 抽取重构，但抽取过程不破坏 V2 运行链路。
