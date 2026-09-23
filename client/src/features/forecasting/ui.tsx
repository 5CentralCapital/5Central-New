import React from "react";
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { ForecastApiError } from "./api";
import { moneyWhole } from "./format";

export type Drill = (line: string, period: string) => void;

export function errorText(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error ? error.message : fallback;
}

export function Notice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="fc-alert" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{errorText(error)}</span>
    {onRetry && <button type="button" className="rm-button rm-button--small" onClick={onRetry}>{error instanceof ForecastApiError && error.conflict ? "Reload" : "Try Again"}</button>}</div>;
}

/** Title 3 heading, one line, one action. */
export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return <div className="fc-empty" role="status"><h3>{title}</h3><p>{message}</p>{action}</div>;
}

export function Field({ label, children, wide = false, help }: { label: string; children: ReactNode; wide?: boolean; help?: string }) {
  return <label className={`rm-field${wide ? " rm-field--wide" : ""}`}><span className="rm-field-label">{label}</span>{children}{help && <span className="rm-field-help">{help}</span>}</label>;
}

/** Table cell value that opens its drilldown. */
export function DrillCell({ cents, line, period, label, onDrill, currency = "USD", emphasis = false }: {
  cents: string | null | undefined; line: string; period: string; label: string; onDrill: Drill; currency?: string; emphasis?: boolean;
}) {
  const negative = typeof cents === "string" && cents.startsWith("-");
  return <td className={`fc-num${negative ? " fc-num--negative" : ""}${emphasis ? " fc-num--strong" : ""}`}>
    <button type="button" className="fc-cell" onClick={() => onDrill(line, period)} aria-label={`${label}: ${moneyWhole(cents, currency)}. Show contributing events`}>
      {moneyWhole(cents, currency)}
    </button>
  </td>;
}

export function Dialog({ title, subtitle, onClose, onSubmit, saving, submitLabel, children, destructive = false }: {
  title: string; subtitle?: string; onClose: () => void; onSubmit: (event: FormEvent) => void; saving: boolean; submitLabel: string; children: ReactNode; destructive?: boolean;
}) {
  const titleId = `fc-dialog-${useId().replace(/:/g, "")}`;
  const formId = `${titleId}-form`;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea")?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose, saving]);
  return <div className="rm-dialog-backdrop fc-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section ref={panel} className="rm-dialog fc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <div className="rm-dialog-header fc-dialog-header">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="rm-button rm-button--icon rm-button--ghost" aria-label="Close" onClick={onClose} disabled={saving}><X size={17} /></button>
      </div>
      <form id={formId} className="rm-dialog-body fc-dialog-body" onSubmit={onSubmit} noValidate>
        <fieldset className="fc-fieldset" disabled={saving}>{children}</fieldset>
      </form>
      <div className="rm-dialog-footer fc-dialog-footer">
        <button type="button" className="rm-button" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" form={formId} className={destructive ? "rm-button rm-button-danger" : "rm-button rm-button-primary"} disabled={saving}>
          {saving ? <><LoaderCircle size={15} className="fc-spin" aria-hidden="true" />Saving…</> : submitLabel}
        </button>
      </div>
    </section>
  </div>;
}
