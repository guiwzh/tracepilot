import type { IssueLevel, IssueStatus, IssueSubstatus } from '@trace-pilot/shared';

// 状态值直接拼成 CSS 修饰类，取值只有 shared 枚举里的三种；ignored 没有单独的样式，用 .status-badge 的默认灰色。
export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <i />
      {status}
    </span>
  );
}

const SUBSTATUS_LABELS: Record<IssueSubstatus, string> = {
  regressed: 'Regressed',
  escalating: 'Escalating',
  until_escalating: 'Until escalating',
};

/** 状态的细分：刚回归、正在恶化、忽略到恶化为止。没有细分时不渲染。 */
export function IssueSubstatusBadge({ substatus }: { substatus?: IssueSubstatus | null }) {
  if (!substatus) return null;
  return (
    <span className={`substatus-badge substatus-${substatus}`}>{SUBSTATUS_LABELS[substatus]}</span>
  );
}

export function LevelMark({ level }: { level: IssueLevel }) {
  return (
    <span className={`level-mark level-${level}`} aria-label={`${level} severity`}>
      !
    </span>
  );
}
