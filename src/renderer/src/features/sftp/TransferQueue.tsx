import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { ConflictAction, TransferJob, TransferState } from '@shared/contracts';
import { formatBytes } from '@shared/features/sftp';
import { api } from '../../lib/api';
import { attempt } from '../../state/appStore';
import { Button, Checkbox, cx, IconButton, Modal } from '../../components/ui/primitives';
import { ProgressBar } from '../../components/ui/ToolView';
import { isFinishedJob, useSftp } from './sftpStore';

const STATE_LABEL: Record<TransferState, string> = {
  scanning: 'Wird erfasst…',
  queued: 'Wartet',
  running: 'Läuft',
  conflict: 'Konflikt',
  done: 'Fertig',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
  skipped: 'Übersprungen'
};

/** What needs attention first; a folder of thousands of files must not bury it. */
const STATE_ORDER: Record<TransferState, number> = {
  conflict: 0,
  failed: 1,
  running: 2,
  scanning: 3,
  queued: 4,
  cancelled: 5,
  skipped: 6,
  done: 7
};
const MAX_ROWS = 200;

function ConflictDialog({ job, total }: { job: TransferJob; total: number }) {
  const resolveConflict = useSftp((state) => state.resolveConflict);
  const [applyToBatch, setApplyToBatch] = useState(false);
  const decide = (action: ConflictAction) => void attempt(() => resolveConflict(job.id, action, applyToBatch));
  const existing = job.conflict;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && decide('skip')}
      title={`„${job.name}“ existiert bereits`}
      description={job.destination}
      width={480}
    >
      <div className="flex flex-col gap-3 px-5 pb-4">
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 rounded-card border border-border bg-canvas p-3 text-xs">
          <dt className="text-secondary">Am Ziel</dt>
          <dd className="text-text">
            {existing ? `${formatBytes(existing.size)}, ${new Date(existing.modifiedAt).toLocaleString('de-DE')}` : 'unbekannt'}
          </dd>
          <dt className="text-secondary">Neu</dt>
          <dd className="text-text">{formatBytes(job.size)}</dd>
        </dl>
        {total > 1 && (
          <Checkbox label={`Für alle ${total} Konflikte dieser Übertragung`} checked={applyToBatch} onChange={setApplyToBatch} />
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={() => decide('skip')}>Überspringen</Button>
        <Button onClick={() => decide('rename')}>Beide behalten</Button>
        <Button variant="danger" onClick={() => decide('overwrite')}>
          Überschreiben
        </Button>
      </div>
    </Modal>
  );
}

function JobRow({ job }: { job: TransferJob }) {
  const retry = useSftp((state) => state.retry);
  const progress = job.size > 0 ? Math.min(1, job.transferred / job.size) : job.state === 'done' ? 1 : null;
  const canCancel = !isFinishedJob(job);
  const canRetry = job.state === 'failed' || job.state === 'cancelled';
  return (
    <div data-testid="transfer-job" data-state={job.state} className="flex min-h-9 flex-none items-center gap-2 px-3 py-1">
      {job.direction === 'upload' ? (
        <ArrowUpFromLine size={13} className="flex-none text-cyan" />
      ) : (
        <ArrowDownToLine size={13} className="flex-none text-purple" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs text-text" title={`${job.source} → ${job.destination}`}>
            {job.name}
          </span>
          <span
            className={cx(
              'flex-none text-[11px]',
              job.state === 'failed' ? 'text-error' : job.state === 'conflict' ? 'text-warning' : 'text-secondary'
            )}
          >
            {STATE_LABEL[job.state]}
          </span>
          <span className="ml-auto flex-none text-[11px] text-subtle">
            {formatBytes(job.transferred)} / {formatBytes(job.size)}
            {job.state === 'running' && job.bytesPerSecond > 0 ? ` · ${formatBytes(job.bytesPerSecond)}/s` : ''}
          </span>
        </div>
        {job.state === 'running' || job.state === 'queued' || job.state === 'scanning' ? (
          <ProgressBar value={job.state === 'scanning' ? null : progress} label={`Fortschritt ${job.name}`} />
        ) : (
          job.error && <span className="truncate text-[11px] text-error select-text" title={job.error}>{job.error}</span>
        )}
      </div>
      {canRetry && (
        <IconButton
          label={`${job.name} wiederholen`}
          onClick={() => void attempt(() => retry(job.id))}
        >
          <RotateCcw size={13} />
        </IconButton>
      )}
      {canCancel && (
        <IconButton
          label={`${job.name} abbrechen`}
          onClick={() => void attempt(() => api.invoke(Channels.transfersCancel, { jobId: job.id, batchId: null }))}
        >
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}

export function TransferQueue() {
  const jobs = useSftp((state) => state.jobs);
  const [collapsed, setCollapsed] = useState(false);

  const { ordered, active, failed, conflicts, overall } = useMemo(() => {
    const all = Object.values(jobs);
    const running = all.filter((job) => !isFinishedJob(job));
    const size = running.reduce((sum, job) => sum + job.size, 0);
    const moved = running.reduce((sum, job) => sum + job.transferred, 0);
    return {
      ordered: [...all].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]),
      active: running,
      failed: all.filter((job) => job.state === 'failed').length,
      conflicts: all.filter((job) => job.state === 'conflict'),
      overall: size > 0 ? moved / size : null
    };
  }, [jobs]);

  const total = ordered.length;
  const firstConflict = conflicts[0];
  const batchConflicts = firstConflict ? conflicts.filter((job) => job.batchId === firstConflict.batchId).length : 0;

  return (
    <section aria-label="Übertragungen" data-testid="transfer-queue" className="flex flex-none flex-col rounded-card border border-border bg-card">
      <div className="flex h-9 flex-none items-center gap-2 px-3">
        <IconButton
          label={collapsed ? 'Übertragungen einblenden' : 'Übertragungen ausblenden'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </IconButton>
        <span className="text-xs font-semibold text-text">Übertragungen</span>
        <span className="text-[11px] text-secondary">
          {total === 0 ? 'keine' : `${active.length} aktiv, ${total} gesamt`}
        </span>
        {failed > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-error">
            <AlertTriangle size={12} /> {failed} fehlgeschlagen
          </span>
        )}
        {active.length > 0 && overall !== null && (
          <div className="w-32">
            <ProgressBar value={overall} label="Gesamtfortschritt" />
          </div>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          className="!h-6 !px-2 text-xs"
          disabled={active.length === 0}
          onClick={() =>
            void attempt(async () => {
              for (const batchId of new Set(active.map((job) => job.batchId))) {
                await api.invoke(Channels.transfersCancel, { jobId: null, batchId });
              }
            })
          }
        >
          Alle abbrechen
        </Button>
        <Button
          variant="ghost"
          className="!h-6 !px-2 text-xs"
          disabled={total === active.length}
          onClick={() => void attempt(() => api.invoke(Channels.transfersClearFinished))}
        >
          Fertige entfernen
        </Button>
      </div>
      {!collapsed && total > 0 && (
        <div className="flex max-h-44 flex-col overflow-y-auto border-t border-border">
          {ordered.slice(0, MAX_ROWS).map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          {total > MAX_ROWS && <p className="px-3 py-1 text-[11px] text-subtle">… und {total - MAX_ROWS} weitere</p>}
        </div>
      )}
      {firstConflict && <ConflictDialog key={firstConflict.id} job={firstConflict} total={batchConflicts} />}
    </section>
  );
}
