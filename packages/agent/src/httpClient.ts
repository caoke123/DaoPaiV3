/**
 * HTTP Client 骨架
 *
 * 封装对 Cloud /agent/* 接口的 HTTP 请求。
 * 本阶段只实现 /agent/me 和 /agent/heartbeat 方法骨架，
 * 其他接口保留 TODO 注释。
 */

import axios, { type AxiosInstance } from 'axios';
import type { AgentConfig, HeartbeatRequest, HeartbeatResponse, AgentMeResponse } from './types';

/** 创建带鉴权的 HTTP 客户端 */
export function createHttpClient(config: AgentConfig): AxiosInstance {
  const client = axios.create({
    baseURL: config.cloudBaseUrl,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.agentToken}`,
    },
  });

  // 响应拦截：统一处理错误
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response) {
        const { status, data } = err.response;
        if (status === 401) {
          console.error('执行电脑授权码无效，请检查 agent.json 中的 agentToken');
        } else if (status === 403) {
          console.error('执行电脑已停用或已删除，请联系管理员');
        }
        return Promise.reject(new Error(
          data?.message || `请求失败 (${status})`
        ));
      }
      return Promise.reject(new Error(`无法连接 Cloud：${err.message}`));
    }
  );

  return client;
}

/**
 * 验证执行电脑授权码，获取执行电脑信息
 * GET /agent/me
 */
export async function getAgentMe(client: AxiosInstance): Promise<AgentMeResponse> {
  const res = await client.get('/agent/me');
  return res.data.data;
}

/**
 * 发送心跳，上报在线状态
 * POST /agent/heartbeat
 */
export async function sendHeartbeat(
  client: AxiosInstance,
  payload: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  const res = await client.post('/agent/heartbeat', payload);
  return res.data.data;
}

// TODO Phase 4-E/F：以下方法待实现
// - pullTask(client, capabilities, siteId) → POST /agent/tasks/pull
// - reportProgress(client, taskId, progress) → POST /agent/tasks/:id/progress
// - uploadLogs(client, taskId, logs) → POST /agent/tasks/:id/logs
// - completeTask(client, taskId, result) → POST /agent/tasks/:id/complete
// - failTask(client, taskId, error) → POST /agent/tasks/:id/fail