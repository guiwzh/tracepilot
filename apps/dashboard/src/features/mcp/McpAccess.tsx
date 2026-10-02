import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type { CreatedApiToken } from '@trace-pilot/shared';
import { CopyButton } from '../../components/CopyButton';
import { API_URL, api } from '../../services/api';
import { absoluteTime, relativeTime } from '../../utils/format';

/** 刚创建的令牌：明文只显示这一次，连同两种客户端的配置写法。 */
function NewToken({ created, onDone }: { created: CreatedApiToken; onDone: () => void }) {
  const endpoint = `${API_URL}/mcp`;
  const claude = `claude mcp add --transport http tracepilot ${endpoint} --header "Authorization: Bearer ${created.token}"`;
  const cursor = JSON.stringify(
    {
      mcpServers: {
        tracepilot: { url: endpoint, headers: { Authorization: `Bearer ${created.token}` } },
      },
    },
    null,
    2,
  );
  return (
    <div className="new-token" role="status">
      <p>
        <strong>Copy “{created.name}” now.</strong> TracePilot keeps only a hash; this token is not
        shown again.
      </p>
      <div className="token-line">
        <code>{created.token}</code>
        <CopyButton value={created.token} label="token" />
      </div>
      <div className="token-snippet">
        <span>Claude Code</span>
        <pre>{claude}</pre>
        <CopyButton value={claude} label="Claude Code command" />
      </div>
      <div className="token-snippet">
        <span>Cursor · .cursor/mcp.json</span>
        <pre>{cursor}</pre>
        <CopyButton value={cursor} label="Cursor configuration" />
      </div>
      <button type="button" className="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

/**
 * 项目设置页的「MCP 访问」：创建和吊销只读令牌。编码 Agent 拿到令牌后，通过 /mcp 调用和排障 Agent
 * 同一套只读工具。吊销分两步点击，避免误删正在用的令牌。
 */
export function McpAccess({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const tokens = useQuery({
    queryKey: ['tokens', projectId],
    queryFn: () => api.tokens(projectId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tokens', projectId] });
  const create = useMutation({
    mutationFn: () => api.createToken(projectId, name.trim()),
    onSuccess: async (token) => {
      setCreated(token);
      setName('');
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.revokeToken(tokenId),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
  });

  return (
    <section className="panel mcp-access" aria-label="MCP access">
      <div className="panel-title">
        <div>
          <KeyRound size={14} />
          <h2>MCP access</h2>
        </div>
        <small>Read-only · this project only</small>
      </div>
      <div className="settings-body">
        <p className="settings-note">
          Let Claude Code, Cursor or any MCP client read this project’s issues, events, source
          context and investigation reports through <code>{API_URL}/mcp</code>.
        </p>
        {created ? (
          <NewToken created={created} onDone={() => setCreated(null)} />
        ) : (
          <form
            className="token-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <label className="pattern-field">
              <span>Token name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Claude Code on my laptop"
                maxLength={80}
              />
            </label>
            <button className="button button-primary" disabled={!name.trim() || create.isPending}>
              Create token
            </button>
            {create.error && <p className="form-error">{create.error.message}</p>}
          </form>
        )}
        {tokens.data?.items.length ? (
          <ul className="token-list">
            {tokens.data.items.map((token) => (
              <li key={token.id}>
                <span>
                  <strong>{token.name}</strong>
                  <small>
                    <code>{token.prefix}…</code> · created {absoluteTime(token.createdAt)} ·{' '}
                    {token.lastUsedAt ? `used ${relativeTime(token.lastUsedAt)}` : 'never used'}
                  </small>
                </span>
                {confirming === token.id ? (
                  <button
                    type="button"
                    className="button button-signal"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(token.id)}
                  >
                    Confirm revoke
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => setConfirming(token.id)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : tokens.isSuccess ? (
          <p className="settings-note">No tokens yet.</p>
        ) : null}
        {revoke.error && <p className="form-error">{revoke.error.message}</p>}
      </div>
    </section>
  );
}
