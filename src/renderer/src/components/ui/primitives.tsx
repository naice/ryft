import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { Dialog as RadixDialog, Tooltip as RadixTooltip } from 'radix-ui';
import { useApp } from '../../state/appStore';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
export { cx };

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-cyan text-on-cyan font-semibold hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100',
  secondary: 'bg-raised text-text border border-border hover:border-border-hover disabled:opacity-40',
  ghost: 'text-secondary hover:bg-hover hover:text-text disabled:opacity-40',
  danger: 'bg-error text-on-cyan font-semibold hover:brightness-110 disabled:opacity-40'
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(function Button({ variant = 'secondary', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-3 text-[13px] transition-[filter,background-color,border-color,color] duration-120',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
});

/** An icon needs a name for assistive tech and a tooltip for everyone else. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; size?: number }
>(function IconButton({ label, shortcut, size = 24, className, style, children, type = 'button', ...props }, ref) {
  return (
    <Tooltip label={shortcut ? `${label} (${shortcut})` : label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        style={{ width: size, height: size, ...style }}
        className={cx(
          'ryft-no-drag inline-flex flex-none items-center justify-center rounded-control text-secondary transition-colors duration-120 hover:bg-hover hover:text-text disabled:opacity-40',
          className
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] rounded-control border border-border bg-raised px-2 py-1 text-[11px] text-text shadow-float"
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export const TEXTAREA =
  'ryft-bare-input w-full resize-y rounded-control border border-border bg-canvas px-2.5 py-1.5 font-terminal text-xs text-text select-text focus:border-border-active';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-[34px] w-full rounded-control border border-border bg-canvas px-2.5 text-[13px] text-text outline-none transition-colors duration-120 select-text placeholder:text-subtle hover:border-border-hover focus:border-border-active aria-[invalid=true]:border-error',
        className
      )}
      {...props}
    />
  );
});

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children
}: {
  label: string;
  htmlFor?: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <span role="alert" className="text-[11px] text-error">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[11px] text-subtle">{hint}</span>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className={cx('flex items-start gap-2 text-[13px] text-text', disabled && 'opacity-50')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 accent-[var(--ryft-cyan)]"
      />
      <span className="flex flex-col">
        {label}
        {hint && <span className="text-[11px] text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

export function Select({
  id,
  value,
  onChange,
  options,
  ariaLabel
}: {
  id?: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-[34px] w-full rounded-control border border-border bg-canvas px-2 text-[13px] text-text outline-none hover:border-border-hover focus:border-border-active"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  width = 480,
  children,
  dismissable = true
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  width?: number;
  children: ReactNode;
  dismissable?: boolean;
}) {
  const returnFocus = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) returnFocus.current = document.activeElement;
  wasOpen.current = open;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ryft-anim-overlay fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content
          style={{ width }}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(event) => {
            // Focusing the close button would open its tooltip, and the first Escape would only close that.
            event.preventDefault();
            (event.target as HTMLElement).focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Whatever the dialog led to, such as a new terminal, may have taken the focus already.
            if (document.activeElement === document.body && returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
          }}
          onInteractOutside={(event) => {
            if (!dismissable) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (!dismissable) event.preventDefault();
          }}
          className="ryft-anim-pop fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] ryft-bare-input max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-panel border border-border bg-host-panel shadow-float"
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-base font-semibold text-text">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-[13px] break-words whitespace-pre-line text-secondary">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            {dismissable && (
              <RadixDialog.Close asChild>
                <IconButton label="Schließen">
                  <X size={16} />
                </IconButton>
              </RadixDialog.Close>
            )}
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function ConfirmDialog() {
  const confirm = useApp((state) => state.confirm);
  const close = useApp((state) => state.closeConfirm);
  const [acknowledged, setAcknowledged] = useState(false);
  // Every question gets its own answer: a tick from the last one does not carry over.
  useEffect(() => setAcknowledged(false), [confirm]);
  return (
    <Modal
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={confirm?.title ?? ''}
      description={confirm?.message}
      width={confirm?.acknowledge ? 520 : 400}
    >
      {confirm?.acknowledge && (
        <div className="px-5 pb-3">
          <Checkbox label={confirm.acknowledge} checked={acknowledged} onChange={setAcknowledged} />
        </div>
      )}
      <div className="flex justify-end gap-2 px-5 pb-4">
        <Button onClick={close}>Abbrechen</Button>
        <Button
          variant={confirm?.danger ? 'danger' : 'primary'}
          disabled={Boolean(confirm?.acknowledge) && !acknowledged}
          onClick={() => {
            confirm?.onConfirm();
            close();
          }}
        >
          {confirm?.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

const TOAST_ICONS = { info: Info, success: CheckCircle2, error: AlertTriangle };
const TOAST_COLORS = { info: 'text-cyan', success: 'text-success', error: 'text-error' };

export function ToastStack() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);
  return (
    <div aria-live="polite" className="fixed right-4 bottom-4 z-[70] flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = TOAST_ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="ryft-anim-pop flex items-start gap-2 rounded-card border border-border bg-raised p-3 shadow-float"
          >
            <Icon size={16} className={cx('mt-px flex-none', TOAST_COLORS[toast.tone])} />
            <span className="min-w-0 flex-1 text-[13px] break-words text-text">{toast.message}</span>
            <button
              type="button"
              aria-label="Meldung schließen"
              onClick={() => dismiss(toast.id)}
              className="flex-none text-subtle hover:text-text"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <div className="text-subtle">{icon}</div>
      <div className="text-[13px] font-semibold text-text">{title}</div>
      <p className="max-w-[260px] text-xs leading-[18px] text-secondary">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
