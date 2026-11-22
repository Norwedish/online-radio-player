/** Small component kit for the broadcast console. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Loader2, X } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Tone = "default" | "primary" | "danger" | "ghost" | "live";

const TONES: Record<Tone, string> = {
  default: "bg-panel-2 border-line-strong hover:border-muted text-legend",
  primary: "bg-tally text-desk border-tally hover:brightness-110 font-semibold",
  danger: "bg-transparent border-clip/60 text-clip hover:bg-clip/10",
  ghost: "bg-transparent border-transparent hover:bg-panel-2 text-muted hover:text-legend",
  live: "bg-clip text-white border-clip hover:brightness-110 font-semibold",
};

export function Button({
  tone = "default",
  busy,
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone;
  busy?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border transition-colors disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm"
          ? "h-8 px-2.5 text-sm"
          : size === "lg"
            ? "h-12 px-5 text-base"
            : "h-9 px-3.5 text-sm",
        TONES[tone],
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Destructive actions require a second click (PLAN 6.9). */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click again to confirm",
  ...rest
}: Omit<Parameters<typeof Button>[0], "onClick"> & {
  onConfirm: () => void;
  confirmLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      {...rest}
      tone={armed ? "live" : (rest.tone ?? "danger")}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

const fieldCore =
  "rounded-md border border-line-strong bg-desk px-3 text-sm text-legend placeholder:text-faint focus:border-tally focus:outline-none";
/** Full width unless the caller passes its own width class. */
function fieldClass(extra: string, className?: string): string {
  return cx(
    fieldCore,
    /(^|\s)(w-|min-w-|flex-1)/.test(className ?? "") ? "" : "w-full",
    extra,
    className,
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={fieldClass("h-9", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={fieldClass("py-2 min-h-20", props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={fieldClass("h-9 pr-8", props.className)}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5 text-sm disabled:opacity-50"
    >
      <span
        className={cx(
          "relative h-5 w-9 rounded-full border transition-colors",
          checked ? "bg-tally border-tally" : "bg-desk border-line-strong",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 size-3.5 rounded-full transition-all",
            checked ? "left-[18px] bg-desk" : "left-0.5 bg-muted",
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel", className)}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="font-display text-lg font-semibold tracking-wide">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      ) : null}
      <div className={cx("p-4", bodyClass)}>{children}</div>
    </section>
  );
}

const BADGE: Record<string, string> = {
  neutral: "border-line-strong text-muted",
  good: "border-signal/50 text-signal",
  warn: "border-tally/60 text-tally",
  bad: "border-clip/60 text-clip",
  info: "border-info/50 text-info",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof BADGE;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-px text-xs whitespace-nowrap",
        BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function severityTone(s: string): keyof typeof BADGE {
  return s === "critical" || s === "error" ? "bad" : s === "warning" ? "warn" : "info";
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-wide">{title}</h1>
        {description ? <p className="mt-0.5 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line px-6 py-10 text-center">
      <p className="font-display text-lg">{title}</p>
      {children ? <p className="max-w-md text-sm text-muted">{children}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-panel-2", className)} />;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
}) {
  return (
    <div role="tablist" className="inline-flex rounded-md border border-line bg-desk p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cx(
            "rounded px-3 py-1 text-sm",
            value === t.value ? "bg-panel-2 text-legend" : "text-muted hover:text-legend",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cx(
        "m-auto w-[calc(100%-2rem)] rounded-lg border border-line-strong bg-panel p-0 text-legend backdrop:bg-black/60",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open ? (
        <div>
          <header className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-display text-xl font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-muted hover:text-legend"
            >
              <X className="size-5" />
            </button>
          </header>
          <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_th]:border-b [&_th]:border-line-strong [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}
