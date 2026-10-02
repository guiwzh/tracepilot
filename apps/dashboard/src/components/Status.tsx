import type { IssueLevel, IssueStatus, IssueSubstatus } from '@trace-pilot/shared';

// 状态值同时进入 CSS 修饰类；shared 枚举保证不会生成未定义的样式后缀。
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
