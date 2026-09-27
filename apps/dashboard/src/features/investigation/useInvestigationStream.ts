import { useEffect, useReducer } from 'react';
import type { InvestigationEvent, InvestigationStreamEvent } from '@trace-pilot/shared';
import { api } from '../../services/api';
import {
  initialInvestigationState,
  investigationReducer,
  type InvestigationViewState,
} from './reducer';

/**
 * 订阅一次调查的事件流。
 *
 * - 用 EventSource：断线后浏览器自动重连，并在请求头里带上 Last-Event-ID，服务端据此续传。
 *   它只能发 GET、不能自定义请求头，这里不需要鉴权头，所以够用；需要时要换成
 *   fetch + ReadableStream 自己解析并实现重连。
 * - 收到终止事件后主动 close()：服务端结束响应时 EventSource 会当成断线继续重连。
 * - 模型流式输出时事件很密。每个事件都 dispatch 会让组件每秒重渲染几十次，
 *   所以先攒进缓冲，每一帧（requestAnimationFrame）合并 dispatch 一次。
 * - 事件和连接状态都记在它们所属的 runId 名下。runId 变化后旧状态自然作废，
 *   不需要在 effect 里同步重置（那会让组件多渲染一轮）。
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

interface StreamState {
  runId: string | null;
  connection: StreamConnection;
  view: InvestigationViewState;
}

type StreamAction =
  | { type: 'events'; runId: string; records: InvestigationStreamEvent[] }
  | { type: 'connection'; runId: string; connection: StreamConnection };

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  // 另一个 runId 的动作意味着已经切换到新的运行：从空状态重新开始。
  const base: StreamState =
    state.runId === action.runId
      ? state
      : { runId: action.runId, connection: 'connecting', view: initialInvestigationState };
  if (action.type === 'connection') return { ...base, connection: action.connection };
  return {
    ...base,
    view: investigationReducer(base.view, { type: 'events', records: action.records }),
  };
}

const initialStreamState: StreamState = {
  runId: null,
  connection: 'idle',
  view: initialInvestigationState,
};

export function useInvestigationStream(runId: string | null) {
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState);

  useEffect(() => {
    if (!runId) return;
    // after=0：首次连接回放完整过程，刷新页面也能看到之前的每一步。
    const source = new EventSource(api.investigationEventsUrl(runId, 0));
    let buffer: InvestigationStreamEvent[] = [];
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (buffer.length === 0) return;
      const records = buffer;
      buffer = [];
      dispatch({ type: 'events', runId, records });
    };

    const onEvent = (message: MessageEvent<string>) => {
      const record = JSON.parse(message.data) as InvestigationStreamEvent;
      buffer.push(record);
      if (TERMINAL.has(record.event.type)) {
        source.close();
        cancelAnimationFrame(frame);
        flush();
        dispatch({ type: 'connection', runId, connection: 'closed' });
        return;
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, onEvent as EventListener);
    source.onopen = () => dispatch({ type: 'connection', runId, connection: 'open' });
    source.onerror = () => {
      // 服务端返回 204（运行已结束且没有新事件）时 readyState 变为 CLOSED，不会再重连。
      dispatch({
        type: 'connection',
        runId,
        connection: source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
      });
    };

    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  const current = stream.runId === runId;
  return {
    state: current ? stream.view : initialInvestigationState,
    connection: !runId ? 'idle' : current ? stream.connection : 'connecting',
  } satisfies { state: InvestigationViewState; connection: StreamConnection };
}
