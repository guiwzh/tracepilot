import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Boxes,
  ChevronDown,
  Gauge,
  LayoutList,
  Radio,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { IssueStatusBadge, LevelMark } from './Status';
import { relativeTime } from '../utils/format';

/** 项目内页面共用的侧栏与顶栏。 */
export function AppShell() {
  const { projectId = 'demo-project' } = useParams();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const commandButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 相同 ['projects'] queryKey 会复用全局 QueryClient 中的项目列表缓存。
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.items.find((item) => item.id === projectId);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const dismissSearch = useCallback(() => {
    setSearchOpen(false);
    requestAnimationFrame(() => commandButtonRef.current?.focus());
  }, []);
  const searchParams = useMemo(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '8', order: 'desc' });
    if (debouncedSearch) params.set('search', debouncedSearch);
    return params;
  }, [debouncedSearch]);
  const searchResults = useQuery({
    queryKey: ['global-search', projectId, searchParams.toString()],
    queryFn: () => api.issues(projectId, searchParams),
    enabled: searchOpen,
  });

  const viewAllPath = useMemo(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '10' });
    const value = searchValue.trim();
    if (value) params.set('search', value);
    return `/projects/${projectId}/issues?${params}`;
  }, [projectId, searchValue]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchValue.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [searchValue]);

  useEffect(() => {
    if (!searchOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [searchOpen]);

  useEffect(() => {
    // 全局快捷键属于副作用，组件卸载时必须移除监听器。
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault();
        dismissSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissSearch, openSearch, searchOpen]);

  // 切换项目时关闭搜索并清空输入：渲染期间比较上一次的 projectId 直接调整，避免 effect 里 setState。
  const [searchProjectId, setSearchProjectId] = useState(projectId);
  if (searchProjectId !== projectId) {
    setSearchProjectId(projectId);
    setSearchOpen(false);
    setSearchValue('');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="TracePilot projects">
          <span className="brand-mark">
            <Radio size={17} strokeWidth={2.4} />
          </span>
          <span>TracePilot</span>
        </Link>

        <label className="project-switcher">
          <span className="project-avatar">{project?.name.slice(0, 2).toUpperCase() ?? 'TP'}</span>
          <span>
            <small>Active project</small>
            <strong>{project?.name ?? 'Loading…'}</strong>
          </span>
          <select
            aria-label="Switch project"
            value={projectId}
            onChange={(event) => navigate(`/projects/${event.target.value}/issues`)}
          >
            {projects.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>

        <nav className="primary-nav" aria-label="Primary">
          <p>Observe</p>
          <NavLink to={`/projects/${projectId}/issues`}>
            <LayoutList size={17} /> Issues
          </NavLink>
          <NavLink to={`/projects/${projectId}/performance`}>
            <Gauge size={17} /> Performance
          </NavLink>
          <p>Ship</p>
          <NavLink to={`/projects/${projectId}/releases`}>
            <Boxes size={17} /> Releases
          </NavLink>
          <NavLink to={`/projects/${projectId}/settings`}>
            <SlidersHorizontal size={17} /> Settings
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <div className="ingest-state">
            <span /> Ingest online
          </div>
          <small>Local evidence console</small>
        </div>
      </aside>

      <div className="work-area">
        <header className="topbar">
          <div className="topbar-context">
            <Activity size={16} /> Production <span>/</span> All releases
          </div>
          <button
            ref={commandButtonRef}
            className="command-button"
            type="button"
            aria-label="Search evidence"
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            onClick={openSearch}
          >
            <Search size={15} /> <span>Search evidence</span> <kbd>⌘ K</kbd>
          </button>
          <div className="operator" title="Local operator">
            GW
          </div>
        </header>
        {/* 当前 Issues / Performance / Releases / Settings / IssueDetail 页面在此渲染。 */}
        <Outlet />
      </div>

      {searchOpen ? (
        <div
          className="global-search-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissSearch();
          }}
        >
          <section
            className="global-search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search evidence"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled])',
                ),
              ).filter((element) => element.offsetParent !== null);
              const first = controls[0];
              const last = controls.at(-1);
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="global-search-header">
              <form
                className="global-search-field"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearchOpen(false);
                  navigate(viewAllPath);
                }}
              >
                <Search size={19} />
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label="Search issues"
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder="Search titles, fingerprints or trace ids"
                  autoComplete="off"
                />
                {searchValue ? (
                  <button
                    type="button"
                    className="global-search-clear"
                    aria-label="Clear search"
                    onClick={() => setSearchValue('')}
                  >
                    <X size={15} />
                  </button>
                ) : null}
              </form>
              <button
                type="button"
                className="global-search-close"
                aria-label="Close search"
                onClick={dismissSearch}
              >
                <X size={18} />
              </button>
            </div>

            <div className="global-search-caption">
              <strong>{debouncedSearch ? 'Matching evidence' : 'Recent evidence'}</strong>
              <span>{searchResults.data?.total ?? 0} grouped issues</span>
            </div>

            <div className="global-search-results" aria-live="polite">
              {searchResults.isLoading ? (
                <p className="global-search-state">Searching evidence…</p>
              ) : searchResults.error ? (
                <p className="global-search-state global-search-error">
                  {searchResults.error.message}
                </p>
              ) : searchResults.data?.items.length ? (
                searchResults.data.items.map((issue) => (
                  <Link
                    key={issue.id}
                    className="global-search-result"
                    to={`/projects/${projectId}/issues/${issue.id}`}
                    onClick={() => setSearchOpen(false)}
                  >
                    <LevelMark level={issue.level} />
                    <span className="global-search-result-main">
                      <strong>{issue.title}</strong>
                      <small>
                        {issue.fingerprint.slice(0, 8)} · {issue.eventCount} events ·{' '}
                        {relativeTime(issue.lastSeenAt)}
                      </small>
                    </span>
                    <IssueStatusBadge status={issue.status} />
                  </Link>
                ))
              ) : (
                <p className="global-search-state">No evidence matched this search.</p>
              )}
            </div>

            <footer className="global-search-footer">
              <span>
                <kbd>Esc</kbd> close · <kbd>Enter</kbd> view all
              </span>
              <Link to={viewAllPath} onClick={() => setSearchOpen(false)}>
                View all results
              </Link>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
