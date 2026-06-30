/**
 * Agent 路由
 *
 * /agent/* 接口使用执行电脑授权码鉴权，与用户 JWT 完全分离。
 * 本阶段只实现 /agent/me 和 /agent/heartbeat。
 *
 * Phase 4-C 协议定义见 docs/V3_PHASE4C_AGENT_API_PROTOCOL.md
 */

import { Router, type Request, type Response } from 'express';
import { requireAgent } from '../auth/agentAuth';
import { PgDatabase } from '../db/PgDatabase';

export const agentRouter = Router();

// ── 所有 /agent/* 路由都需要 Agent Token 鉴权 ──
agentRouter.use(requireAgent);

/** GET /agent/me — 验证授权码，返回执行电脑信息 */
agentRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const principal = req.principal;
    if (!principal || principal.type !== 'agent') {
      return res.status(401).json({ ok: false, code: 'AGENT_TOKEN_INVALID', message: '鉴权失败', timestamp: new Date().toISOString() });
    }

    const pg = PgDatabase.getInstance();
    const ws = await pg.getWorkstationById(principal.tenantId, principal.workstationId);

    if (!ws) {
      return res.status(404).json({ ok: false, code: 'TASK_NOT_FOUND', message: '执行电脑不存在', timestamp: new Date().toISOString() });
    }

    // 查询 tenant 名称和 site 名称
    const tenant = await pg.getTenantById(principal.tenantId);
    let siteName = null;
    if (ws.siteId) {
      const sites = await pg.getSitesByTenant(principal.tenantId);
      const site = sites.find(s => s.id === ws.siteId);
      siteName = site?.name || null;
    }

    // 更新授权码最后使用时间
    await pg.touchAgentToken(principal.workstationId);

    res.json({
      ok: true,
      data: {
        workstationId: ws.id,
        name: ws.name,
        tenantId: ws.tenantId,
        tenantName: tenant?.name || '默认快递公司',
        siteId: ws.siteId,
        siteName: siteName,
        status: ws.status,
        onlineStatus: ws.onlineStatus,
        browserStatus: ws.browserStatus,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[GET /agent/me] 失败:', (e as Error).message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/heartbeat — 心跳上报 */
agentRouter.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const principal = req.principal;
    if (!principal || principal.type !== 'agent') {
      return res.status(401).json({ ok: false, code: 'AGENT_TOKEN_INVALID', message: '鉴权失败', timestamp: new Date().toISOString() });
    }

    const { agentVersion, machineFingerprint, browserStatus } = req.body || {};

    // 更新心跳
    const pg = PgDatabase.getInstance();
    await pg.updateWorkstationHeartbeat({
      workstationId: principal.workstationId,
      tenantId: principal.tenantId,
      browserStatus: browserStatus || 'unknown',
      agentVersion: agentVersion || 'unknown',
      machineFingerprint: machineFingerprint || 'unknown',
      lastIp: req.ip || req.socket.remoteAddress || 'unknown',
    });

    // 更新授权码最后使用时间
    await pg.touchAgentToken(principal.workstationId);

    res.json({
      ok: true,
      data: {
        serverTime: new Date().toISOString(),
        workstationStatus: 'active',
        hasTask: false, // 本阶段固定 false，不做任务拉取
        nextPollAfterMs: 15000,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[POST /agent/heartbeat] 失败:', (e as Error).message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});