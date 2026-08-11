import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, ChevronDown, Gauge, LayoutList, Radio, Search } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';

export function AppShell() {
  const { projectId = 'demo-project' } = useParams();
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.items.find((item) => item.id === projectId);
  const openSearch = useCallback(() => {
    navigate(`/projects/${projectId}/issues?focus=search`);
  }, [navigate, projectId]);

  useEffect(() => {
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
        <Outlet />
      </div>
    </div>
  );
}
