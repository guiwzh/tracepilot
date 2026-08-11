import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Braces, Plus, Radio, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/States';
import { api } from '../services/api';
import { formatNumber, relativeTime } from '../utils/format';

export function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const create = useMutation({
    mutationFn: () => api.createProject(name),
    onSuccess: async () => {
      setName('');
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <main className="project-gate">
      <header className="gate-nav">
        <div className="brand">
          <span className="brand-mark">
            <Radio size={17} />
          </span>
          <span>TracePilot</span>
        </div>
        <span className="gate-label">Evidence console / local</span>
      </header>

      <section className="gate-hero">
        <div>
          <p className="page-eyebrow">Frontend incident intelligence</p>
          <h1>Investigate what the browser actually saw.</h1>
        </div>
        <p>
          TracePilot connects errors, network spans, user actions, releases, and source locations
          into one inspectable evidence chain before any diagnosis is generated.
        </p>
      </section>

      <section className="project-section">
        <div className="section-heading">
          <div>
            <p className="page-eyebrow">Workspace</p>
            <h2>Choose a project</h2>
          </div>
          <button className="button button-primary" onClick={() => setCreating((value) => !value)}>
            <Plus size={15} /> New project
          </button>
        </div>

        {creating && (
          <form
            className="create-project"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <label>
              <span>Project name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer portal"
                autoFocus
              />
            </label>
            <button
              className="button button-primary"
              disabled={create.isPending || name.trim().length < 2}
            >
              Create project
            </button>
            {create.error && <p className="form-error">{create.error.message}</p>}
          </form>
        )}

        {projects.isLoading ? (
          <LoadingState label="Loading projects" />
        ) : projects.error ? (
          <ErrorState message={projects.error.message} />
        ) : (
          <div className="project-list">
            {projects.data?.items.map((project, index) => (
              <Link to={`/projects/${project.id}/issues`} className="project-card" key={project.id}>
                <span className="project-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="project-card-main">
                  <span className="project-monogram">{project.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>Created {relativeTime(project.createdAt)}</small>
                  </span>
                </span>
                <span className="project-stat">
                  <small>Grouped issues</small>
                  <strong>{formatNumber(project.issueCount ?? 0)}</strong>
                </span>
                <span className="project-stat">
                  <small>Total events</small>
                  <strong>{formatNumber(project.eventCount ?? 0)}</strong>
                </span>
                <ArrowRight className="project-arrow" />
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="gate-foot">
        <span>
          <ShieldCheck size={14} /> Source maps stay private
        </span>
        <span>
          <Braces size={14} /> Evidence-first diagnosis
        </span>
      </footer>
    </main>
  );
}
