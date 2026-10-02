import { useMutation } from '@tanstack/react-query';
import { FileCode2 } from 'lucide-react';
import { CopyButton } from '../../components/CopyButton';
import { api } from '../../services/api';

/**
 * 「交给编码 Agent」：把这次调查整理成修复简报（服务端的 investigation/fixBrief.ts），复制给 Claude Code、
 * Cursor 等去改代码。TracePilot 自己不改代码。简报按需生成，不随报告一起加载。
 */
export function FixBriefPanel({ runId, issueId }: { runId: string; issueId: string }) {
  const brief = useMutation({ mutationFn: () => api.fixBrief(runId) });
  const command = `/mcp__tracepilot__fix_issue ${issueId}`;
  return (
    <section className="fix-brief" aria-label="Fix brief">
      <header>
        <div>
          <FileCode2 size={15} />
          <h3>Hand off to a coding agent</h3>
        </div>
        {!brief.data && (
          <button
            type="button"
            className="button"
            disabled={brief.isPending}
            onClick={() => brief.mutate()}
          >
            {brief.isPending ? 'Preparing…' : 'Prepare fix brief'}
          </button>
        )}
      </header>
      <p>
        TracePilot does not change code. The brief gives your coding agent the cited evidence, the
        code it read, the suspect commit and what is still unknown; everything captured from
        production is fenced as data, not instructions.
      </p>
      {brief.error && <p className="form-error">{brief.error.message}</p>}
      {brief.data && (
        <>
          <div className="fix-brief-actions">
            <CopyButton value={brief.data.markdown} label="fix brief" />
            <span>
              {brief.data.codeLocations.length} code location
              {brief.data.codeLocations.length === 1 ? '' : 's'}
              {brief.data.suspectCommit ? ' · suspect commit' : ''} ·{' '}
              {brief.data.evidence.filter((item) => item.verified).length}/
              {brief.data.evidence.length} quotes verified
            </span>
          </div>
          <pre className="fix-brief-markdown" tabIndex={0}>
            {brief.data.markdown}
          </pre>
        </>
      )}
      <div className="fix-brief-mcp">
        <span>With the TracePilot MCP server in Claude Code</span>
        <code>{command}</code>
        <CopyButton value={command} label="Claude Code command" />
      </div>
    </section>
  );
}
