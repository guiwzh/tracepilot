import { AlertTriangle, Inbox, LoaderCircle } from 'lucide-react';

export function LoadingState({ label = 'Loading evidence' }: { label?: string }) {
  return (
    <div className="state-panel">
      <LoaderCircle className="spin" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state-panel state-error">
      <AlertTriangle />
      <p>{message}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Inbox />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
