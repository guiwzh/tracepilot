import { useEffect, useReducer, useState } from 'react';
import type { InvestigationEvent, InvestigationStreamEvent } from '@trace-pilot/shared';
import { api } from '../../services/api';
import { initialInvestigationState, investigationReducer } from './reducer';

/**
 * 订阅一次调查的事件流。
 *
 * - 用 EventSource：断线后浏览器自动重连，并在请求头里带上 Last-Event-ID，服务端据此续传。
 *   它只能发 GET、不能自定义请求头，这里不需要鉴权头，所以够用；需要时要换成
 *   fetch + ReadableStream 自己解析并实现重连。
 * - 收到终止事件后主动 close()：服务端结束响应时 EventSource 会当成断线继续重连。
 * - 模型流式输出时事件很密。每个事件都 dispatch 会让组件每秒重渲染几十次，
 *   所以先攒进缓冲，每一帧（requestAnimationFrame）合并 dispatch 一次。
 */
export type StreamConnection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

const EVENT_TYPES: InvestigationEvent['type'][] = [
  'run.started',
  'step.started',
  'text.delta',
  'tool.called',
  'tool.completed',
  'report.rejected',
  'run.completed',
  'run.failed',
  'run.cancelled',
];

const TERMINAL = new Set<InvestigationEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export function useInvestigationStream(runId: string | null) {
  const [state, dispatch] = useReducer(investigationReducer, initialInvestigationState);
  const [connection, setConnection] = useState<StreamConnection>('idle');

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!runId) {
      setConnection('idle');
      return;
    }
    setConnection('connecting');
    // after=0：首次连接回放完整过程，刷新页面也能看到之前的每一步。
    const source = new EventSource(api.investigationEventsUrl(runId, 0));
    let buffer: InvestigationStreamEvent[] = [];
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (buffer.length === 0) return;
      const records = buffer;
      buffer = [];
      dispatch({ type: 'events', records });
    };

    const onEvent = (message: MessageEvent<string>) => {
      const record = JSON.parse(message.data) as InvestigationStreamEvent;
      buffer.push(record);
      if (TERMINAL.has(record.event.type)) {
        source.close();
        setConnection('closed');
        cancelAnimationFrame(frame);
        flush();
        return;
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, onEvent as EventListener);
    source.onopen = () => setConnection('open');
    source.onerror = () => {
      // 服务端返回 204（运行已结束且没有新事件）时 readyState 变为 CLOSED，不会再重连。
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };

    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  return { state, connection };
}
