import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, FileCode2, Plus, Upload } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { Release } from '@trace-pilot/shared';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, EmptyState, LoadingState } from '../components/States';
import { api } from '../services/api';
import { absoluteTime } from '../utils/format';

function SourceMapUploader({ release }: { release: Release }) {
  const queryClient = useQueryClient();
  const [minifiedFile, setMinifiedFile] = useState('app.js');
  const [file, setFile] = useState<File>();
  const maps = useQuery({
    queryKey: ['source-maps', release.id],
    queryFn: () => api.sourceMaps(release.id),
  });
  const upload = useMutation({
    mutationFn: () => api.uploadSourceMap(release.id, minifiedFile, file!),
    onSuccess: async () => {
      setFile(undefined);
      await queryClient.invalidateQueries({ queryKey: ['source-maps', release.id] });
      await queryClient.invalidateQueries({ queryKey: ['releases', release.projectId] });
    },
  });
  return (
    <details className="release-detail">
      <summary>
        <span>
          <Boxes size={15} />
          <span>
            <strong>{release.version}</strong>
            <small>
              {release.commitSha ?? 'No commit linked'} · {absoluteTime(release.createdAt)}
            </small>
          </span>
        </span>
        <span>{release.sourceMapCount ?? 0} maps</span>
      </summary>
      <div className="release-body">
        <div className="map-list">
          {maps.data?.items.map((map) => (
            <div key={map.id}>
              <FileCode2 size={15} />
              <span>
                <strong>{map.minifiedFile}</strong>
                <small>Uploaded {absoluteTime(map.createdAt)}</small>
              </span>
              <Check size={14} />
            </div>
          ))}
          {maps.data?.items.length === 0 && <p>No maps uploaded for this release.</p>}
        </div>
        <form
          className="map-upload"
          onSubmit={(event) => {
            event.preventDefault();
            if (file && minifiedFile) upload.mutate();
          }}
        >
          <label>
            <span>Minified file name</span>
            <input
              value={minifiedFile}
              onChange={(event) => setMinifiedFile(event.target.value)}
              placeholder="checkout.a81e93bd.js"
            />
          </label>
          <label className="file-input">
            <span>Source map file</span>
            <input
              type="file"
              accept=".map,application/json"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
            <i>{file?.name ?? 'Choose .map file'}</i>
          </label>
          <button className="button button-primary" disabled={!file || upload.isPending}>
            <Upload size={14} /> {upload.isPending ? 'Uploading…' : 'Upload private map'}
          </button>
          {upload.error && <p className="form-error">{upload.error.message}</p>}
        </form>
      </div>
    </details>
  );
}

export function ReleasesPage() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const releases = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () => api.releases(projectId),
  });
  const create = useMutation({
    mutationFn: () => api.createRelease(projectId, version, commitSha),
    onSuccess: async () => {
      setCreating(false);
      setVersion('');
      setCommitSha('');
      await queryClient.invalidateQueries({ queryKey: ['releases', projectId] });
    },
  });
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="Build artifacts / private"
        title="Releases"
        description="Bind browser stacks to the exact source map produced with each deployment."
        actions={
          <button className="button button-primary" onClick={() => setCreating((value) => !value)}>
            <Plus size={14} /> Create release
          </button>
        }
      />
      {creating && (
        <form
          className="create-release"
          onSubmit={(event) => {
            event.preventDefault();
            if (version) create.mutate();
          }}
        >
          <label>
            <span>Version</span>
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="2.5.0"
              autoFocus
            />
          </label>
          <label>
            <span>Commit SHA (optional)</span>
            <input
              value={commitSha}
              onChange={(event) => setCommitSha(event.target.value)}
              placeholder="7f3ac91"
            />
          </label>
          <button className="button button-primary" disabled={create.isPending || !version}>
            Save release
          </button>
          {create.error && <p className="form-error">{create.error.message}</p>}
        </form>
      )}
      {releases.isLoading ? (
        <LoadingState />
      ) : releases.error ? (
        <ErrorState message={releases.error.message} />
      ) : releases.data?.items.length === 0 ? (
        <EmptyState
          title="No releases yet"
          detail="Create a release before uploading its source maps."
        />
      ) : (
        <section className="release-list">
          {releases.data?.items.map((release) => (
            <SourceMapUploader key={release.id} release={release} />
          ))}
        </section>
      )}
    </main>
  );
}
