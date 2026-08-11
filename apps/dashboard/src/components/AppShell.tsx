import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, ChevronDown, Gauge, LayoutList, Radio, Search } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';

/** 项目内页面共用的侧栏与顶栏；Outlet 是 React Router 留给当前子路由的插槽。 */
export function AppShell() {
  const { projectId = 'demo-project' } = useParams();
  const navigate = useNavigate();
  // 相同 ['projects'] queryKey 会复用全局 QueryClient 中的项目列表缓存。
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.items.find((item) => item.id === projectId);
  const openSearch = useCallback(() => {
    navigate(`/projects/${projectId}/issues?focus=search`);
  }, [navigate, projectId]);

  useEffect(() => {
    // 全局快捷键属于副作用，组件卸载时必须移除监听器。
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

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
          <button className="command-button" type="button" onClick={openSearch}>
            <Search size={15} /> Search evidence <kbd>⌘ K</kbd>
          </button>
          <div className="operator" title="Local operator">
            GW
          </div>
        </header>
        {/* 当前 Issues / Performance / Releases / IssueDetail 页面在此渲染。 */}
        <Outlet />
      </div>
    </div>
  );
}
