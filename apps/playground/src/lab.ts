import { createMonitor } from '@trace-pilot/monitor-sdk';
import lab from '../lab.json';

/**
 * 演练场的 SDK 实例与「飞行记录」。
 *
 * SDK 在渲染之前创建并启动，这也是业务应用推荐的接入方式：首次渲染里抛出的错误同样能被采到，
 * 根节点的错误回调（main.tsx）也能引用这个实例。
 *
 * 上报目标可以用地址参数覆盖（?projectId=…&dsnKey=…），E2E 用它把每轮测试写进独立的项目；
 * 否则读取 apps/playground/.env 里的 VITE_* 变量，最后退回演示项目。
 */
const params = new URLSearchParams(location.search);

export const labTarget = {
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4318',
  projectId: params.get('projectId') ?? import.meta.env.VITE_DEMO_PROJECT_ID ?? 'demo-project',
  dsnKey: params.get('dsnKey') ?? import.meta.env.VITE_DEMO_DSN_KEY ?? 'demo-dsn-key',
  // 与 lab.json 同源：生产模式上传 Source Map 时用的是同一个版本号。
  release: lab.release,
};

export interface Activity {
  id: number;
  /** action：点击了哪个场景；event：SDK 实际采到并交给传输层的事件；delivery / problem：投递结果。 */
  kind: 'action' | 'event' | 'delivery' | 'problem';
  label: string;
  detail?: string;
  time: number;
}

let activity: Activity[] = [];
let nextActivityId = 1;
const listeners = new Set<() => void>();

export function record(kind: Activity['kind'], label: string, detail?: string): void {
  activity = [{ id: nextActivityId++, kind, label, detail, time: Date.now() }, ...activity].slice(
    0,
    10,
  );
  for (const listener of listeners) listener();
}

/** 供 useSyncExternalStore 订阅：记录来自 SDK 的回调，不在 React 的状态里。 */
export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activitySnapshot(): Activity[] {
  return activity;
}

function summarize(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === 'network') {
    const outcome =
      payload.businessCode === undefined
        ? String(payload.status)
        : `code ${String(payload.businessCode)}`;
    return `network · ${String(payload.method)} ${String(payload.url)} → ${outcome}`;
  }
  if (eventType === 'performance') {
    return `performance · ${String(payload.metric)} ${String(payload.value)}`;
  }
  return `${eventType} · ${String(payload.message ?? payload.url ?? 'captured')}`;
}

export const monitor = createMonitor({
  dsn: `${labTarget.apiUrl}/api/v1/envelopes`,
  dsnKey: labTarget.dsnKey,
  projectId: labTarget.projectId,
  release: labTarget.release,
  environment: 'production',
  user: { id: `lab-user-${Math.floor(Math.random() * 6) + 1}` },
  // 攒够 3 条或每 2 秒发送一次，演示时不用久等；真实应用用默认值即可。
  batchSize: 3,
  flushInterval: 2_000,
  // 白屏连续 3 次、每次间隔 0.4 秒就上报，演示时不用久等；真实应用用默认值（1 秒 × 5 次）即可。
  whiteScreen: { interval: 400, checks: 3 },
  // 演练场的接口约定 code 为 0 表示成功；HTTP 200 但 code 不为 0 的按失败上报。
  detectBusinessError: ({ body }) => {
    const { code, message } = (body ?? {}) as { code?: number; message?: string };
    return code === undefined || code === 0 ? null : { code, message };
  },
  beforeSend(event) {
    // SDK 的默认脱敏认得出 token、password 和 URL 查询参数，认不出业务数据：
    // customerEmail 是个人信息这件事只有业务自己知道，所以在这里删掉。
    const { customerEmail: _removed, ...payload } = event.payload;
    record('event', summarize(event.eventType, payload), `event ${event.eventId.slice(0, 8)}`);
    return { ...event, payload };
  },
});
monitor.start();

// 现在修改本文件会整页刷新：main.tsx 也引用了它，而入口模块不是热更新边界。万一以后它能被热替换，
// 旧实例要先销毁，否则两份插件会同时包装全局 API。
import.meta.hot?.dispose(() => monitor.destroy());
