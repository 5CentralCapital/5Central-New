import type { ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

/*
 * Shared manager primitives from the design audit. Every module uses these
 * instead of inventing its own empty state, loading value or row buttons.
 * Styles live in styles/rops-system.css under "Shared primitives".
 */

/** Full-width empty state: what the module is for, and one action. */
export function EmptyState({ title, children, action, icon, compact = false }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode; compact?: boolean }) {
  return <div className={`ops-empty${compact ? " is-compact" : ""}`} role="status">
    {icon && <span className="ops-empty-icon" aria-hidden="true">{icon}</span>}
    <strong className="ops-empty-title">{title}</strong>
    {children && <p className="ops-empty-body">{children}</p>}
    {action && <div className="ops-empty-action">{action}</div>}
  </div>;
}

/** Grey placeholder while a value loads. Never shows "Unknown" for a pending request. */
export function Skeleton({ width = "6em", label = "Loading" }: { width?: string; label?: string }) {
  return <span className="ops-skeleton" style={{ width }} role="status" aria-label={label} />;
}

/** "Not verified" marker for real data gaps; the reason goes in the tooltip. */
export function NotVerified({ reason, children = "Not verified" }: { reason?: string; children?: ReactNode }) {
  return <span className="rm-status rm-status--warning ops-not-verified" title={reason}>{children}</span>;
}

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Row overflow menu (···). Rows open their record on click; secondary actions live here. */
export function RowMenu({ items, label = "More actions" }: { items: readonly RowMenuItem[]; label?: string }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return <Dropdown.Root modal={false}>
    <Dropdown.Trigger className="ops-row-menu-trigger" aria-label={label} title={label} onClick={event => event.stopPropagation()}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </Dropdown.Trigger>
    <Dropdown.Portal>
      <Dropdown.Content className="rops-nav-menu ops-row-menu" align="end" sideOffset={4} collisionPadding={12} onClick={event => event.stopPropagation()}>
        {visible.map(item => <Dropdown.Item key={item.label} className={`rops-menu-item${item.danger ? " is-danger" : ""}`} disabled={item.disabled} onSelect={() => item.onSelect()}>{item.label}</Dropdown.Item>)}
      </Dropdown.Content>
    </Dropdown.Portal>
  </Dropdown.Root>;
}

/** One-line status with a colored dot: "● QuickBooks production · synced 30 min ago". */
export function StatusLine({ tone = "neutral", children, actions }: { tone?: "positive" | "warning" | "critical" | "neutral"; children: ReactNode; actions?: ReactNode }) {
  return <div className={`ops-status-line is-${tone}`} role="status">
    <span className="ops-status-dot" aria-hidden="true" />
    <span className="ops-status-text">{children}</span>
    {actions && <span className="ops-status-actions">{actions}</span>}
  </div>;
}

/** Removable filter chip used above report results. */
export function FilterChip({ label, onRemove, onClick }: { label: ReactNode; onRemove?: () => void; onClick?: () => void }) {
  return <span className="ops-chip">
    {onClick ? <button type="button" className="ops-chip-label" onClick={onClick}>{label}</button> : <span className="ops-chip-label">{label}</span>}
    {onRemove && <button type="button" className="ops-chip-remove" aria-label="Remove filter" onClick={onRemove}>×</button>}
  </span>;
}
