import type { IssueLevel, IssueStatus } from '@trace-pilot/shared';

// 状态值同时进入 CSS 修饰类；shared 枚举保证不会生成未定义的样式后缀。
export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <i />
      {status}
    </span>
  );
}

export function LevelMark({ level }: { level: IssueLevel }) {
  return (
    <span className={`level-mark level-${level}`} aria-label={`${level} severity`}>
      !
    </span>
  );
}
