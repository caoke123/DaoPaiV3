# DaoPai 本地执行端

> 当前阶段：**骨架模式（Phase 4-D）**，尚未启用任务执行。

## 什么是本地执行端

本地执行端是安装在员工电脑上的程序，负责：

- 连接 Cloud 云端管理中心
- 接收并执行浏览器自动化任务（到件、派件、到派一体、签收）
- 回传执行进度、日志和结果到 Cloud

本地执行端与 Cloud 的关系：

```
Cloud（云端管理中心） → 下发任务
Local Agent（本地执行端） → 拉取任务、执行、回传结果
```

## 前置条件

1. 在 Cloud 管理后台创建执行电脑，获取**执行电脑授权码**
2. Node.js >= 18

## 快速开始

### 1. 复制配置文件

```bash
cp agent.example.json agent.json
```

### 2. 填写执行电脑授权码

编辑 `agent.json`，将 `agentToken` 替换为从 Cloud 管理后台获取的执行电脑授权码：

```json
{
  "cloudBaseUrl": "http://localhost:3300",
  "agentToken": "daopai_agent_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "workstationName": "天南大-前台电脑01",
  "siteId": null,
  "logLevel": "info",
  "heartbeatIntervalMs": 15000,
  "taskPollIntervalMs": 5000
}
```

### 3. 安装依赖

```bash
npm install
```

### 4. 启动

```bash
npm run dev
```

## 当前阶段说明

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 4-D | **当前** | 项目骨架，启动检查，不执行任务 |
| Phase 4-E | 计划中 | 心跳与在线状态闭环 |
| Phase 4-F | 计划中 | 任务拉取与结果回传最小闭环 |

**当前不会执行以下操作：**

- 不会拉取任务
- 不会执行到件/派件/签收/到派一体
- 不会启动浏览器
- 不会连接 EasyBR
- 不会修改 settings.json

## 目录结构

```
packages/agent/
  agent.example.json   # 配置文件模板（提交 Git）
  agent.json           # 实际配置文件（不提交 Git）
  package.json
  tsconfig.json
  README.md
  src/
    index.ts           # 启动入口
    config.ts          # 配置加载与校验
    logger.ts          # 日志系统
    httpClient.ts      # HTTP 客户端骨架
    startupCheck.ts    # 启动检查流程
    types.ts           # 类型定义
  logs/
    agent.log          # 运行日志（不提交 Git）
```

## 安全注意事项

- `agent.json` 包含执行电脑授权码，**禁止提交到 Git**
- 日志中不会打印执行电脑授权码、员工账号、员工密码
- 执行电脑授权码仅在 Cloud 管理后台创建时显示一次，请妥善保存

## 相关文档

- [Phase 4-A：Local Agent 边界设计](../../docs/V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md)
- [Phase 4-B：Agent Token 与执行电脑鉴权设计](../../docs/V3_PHASE4B_AGENT_TOKEN_AUTH.md)
- [Phase 4-C：Agent API 协议设计](../../docs/V3_PHASE4C_AGENT_API_PROTOCOL.md)