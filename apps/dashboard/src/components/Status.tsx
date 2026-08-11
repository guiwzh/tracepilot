import type { IssueLevel, IssueStatus } from '@trace-pilot/shared';

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
