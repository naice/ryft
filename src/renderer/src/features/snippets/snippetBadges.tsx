import { AlertTriangle, CircleCheck, CircleHelp, CircleSlash, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Compatibility, CompatibilityStatus } from '@shared/features/snippetCompat';
import { RISK_LABEL, type RiskLevel } from '@shared/features/snippetRisk';
import { cx } from '../../components/ui/primitives';

const RISK_ICON = { safe: ShieldCheck, caution: AlertTriangle, danger: ShieldAlert };
const RISK_COLOR: Record<RiskLevel, string> = { safe: 'text-subtle', caution: 'text-warning', danger: 'text-error' };

export function RiskBadge({ risk, compact = false }: { risk: RiskLevel; compact?: boolean }) {
  const Icon = RISK_ICON[risk];
  return (
    <span data-testid="risk-badge" data-risk={risk} title={RISK_LABEL[risk]} className={cx('flex flex-none items-center gap-1 text-[11px]', RISK_COLOR[risk])}>
      <Icon size={12} aria-hidden />
      <span className={compact ? 'sr-only' : undefined}>{RISK_LABEL[risk]}</span>
    </span>
  );
}

const COMPAT_LABEL: Record<CompatibilityStatus, string> = { compatible: 'Passt', incompatible: 'Passt nicht', unknown: 'Unbekannt' };
const COMPAT_ICON = { compatible: CircleCheck, incompatible: CircleSlash, unknown: CircleHelp };
const COMPAT_COLOR: Record<CompatibilityStatus, string> = { compatible: 'text-success', incompatible: 'text-error', unknown: 'text-subtle' };

export function CompatBadge({ compatibility, compact = false }: { compatibility: Compatibility; compact?: boolean }) {
  const { status, reasons } = compatibility;
  const Icon = COMPAT_ICON[status];
  return (
    <span
      data-testid="compat-badge"
      data-compat={status}
      title={reasons.length > 0 ? reasons.join(', ') : COMPAT_LABEL[status]}
      className={cx('flex flex-none items-center gap-1 text-[11px]', COMPAT_COLOR[status])}
    >
      <Icon size={12} aria-hidden />
      <span className={compact ? 'sr-only' : undefined}>{COMPAT_LABEL[status]}</span>
    </span>
  );
}
