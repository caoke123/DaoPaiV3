/**
 * Phase 3-D-2: Runtime 状态模块
 *
 * 跟踪 BrowserPool / EasyBR 运行时可用性，与 Express 启动完全解耦。
 * EasyBR 不可用时：
 *   - Express 正常启动，Auth / 任务中心 API 不受影响
 *   - 执行类接口返回 503 JSON
 */

export type RuntimeHealth = 'available' | 'unavailable' | 'degraded';

interface RuntimeState {
  health: RuntimeHealth;
  error: string | null;
  lastCheckedAt: number | null;
  easybrConnected: boolean;
}

export class RuntimeStatus {
  private state: RuntimeState = {
    health: 'unavailable',
    error: null,
    lastCheckedAt: null,
    easybrConnected: false,
  };

  private static instance: RuntimeStatus;

  static getInstance(): RuntimeStatus {
    if (!RuntimeStatus.instance) {
      RuntimeStatus.instance = new RuntimeStatus();
    }
    return RuntimeStatus.instance;
  }

  /** BrowserPool 初始化成功 */
  markAvailable(): void {
    this.state = {
      health: 'available',
      error: null,
      lastCheckedAt: Date.now(),
      easybrConnected: true,
    };
    console.log('[RuntimeStatus] 状态 → available');
  }

  /** BrowserPool 初始化失败 / EasyBR 不可用 */
  markUnavailable(error: string): void {
    this.state = {
      health: 'unavailable',
      error,
      lastCheckedAt: Date.now(),
      easybrConnected: false,
    };
    console.warn(`[RuntimeStatus] 状态 → unavailable: ${error}`);
  }

  /** 部分窗口可用，部分不可用 */
  markDegraded(error: string): void {
    this.state = {
      health: 'degraded',
      error,
      lastCheckedAt: Date.now(),
      easybrConnected: this.state.easybrConnected,
    };
    console.warn(`[RuntimeStatus] 状态 → degraded: ${error}`);
  }

  /** 获取当前状态 */
  getState(): Readonly<RuntimeState> {
    return this.state;
  }

  /** 是否可用于执行任务 */
  isAvailable(): boolean {
    return this.state.health === 'available';
  }

  /** 获取状态摘要（用于 /api/status） */
  getSummary(): {
    runtime: RuntimeHealth;
    runtimeError: string | null;
    runtimeLastCheckedAt: number | null;
    easybrConnected: boolean;
  } {
    return {
      runtime: this.state.health,
      runtimeError: this.state.error,
      runtimeLastCheckedAt: this.state.lastCheckedAt,
      easybrConnected: this.state.easybrConnected,
    };
  }
}

export const runtimeStatus = RuntimeStatus.getInstance();