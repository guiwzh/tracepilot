import { ExternalLink, Waypoints } from 'lucide-react';
import { traceUrl } from '../utils/trace';
import { CopyButton } from './CopyButton';

/**
 * 一个 W3C trace id（SDK 给发往后端的请求加的 traceparent）：缩写显示，悬停看全文；
 * 配置了链路系统地址时可以直接打开。compact 用在请求列表这类一行一个的地方，不带复制按钮。
 */
export function TraceLink({
  traceId,
  spanId,
  compact = false,
}: {
  traceId: string;
  spanId?: string;
  compact?: boolean;
}) {
  const url = traceUrl(traceId, spanId);
  return (
    <span className="trace-link">
      <Waypoints size={12} aria-hidden="true" />
      <code title={spanId ? `trace ${traceId} · span ${spanId}` : `trace ${traceId}`}>
        trace {traceId.slice(0, 8)}…
      </code>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          Open trace <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}
      {!compact && <CopyButton value={traceId} label="trace id" />}
    </span>
  );
}
