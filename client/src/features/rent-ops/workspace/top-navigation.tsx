import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronRight, Menu, X } from 'lucide-react';
import { activeDestination, activeNavigationGroup, DASHBOARD_DESTINATION, WORKSPACE_NAVIGATION, type WorkspaceDestination } from './navigation';
import { workspaceRouteSearch, type WorkspaceRoute } from './workspace-state';

export type Transparency = 'system' | 'reduced';
const preferenceKey = 'rops:appearance:transparency';
export function useWorkspaceAppearance() {
  const [transparency, setTransparency] = useState<Transparency>(() => {
    try { return localStorage.getItem(preferenceKey) === 'reduced' ? 'reduced' : 'system'; }
    catch { return 'system'; }
  });
  const changeTransparency = (value: Transparency) => {
    setTransparency(value);
    try { localStorage.setItem(preferenceKey, value); } catch { /* Preference still works for this session. */ }
  };
  return { transparency, changeTransparency };
}

/** Two initials from a display name or the local part of an email address. */
export function accountInitials(label: string | undefined): string {
  const source = (label ?? '').split('@')[0]?.replace(/[._-]+/g, ' ').trim() ?? '';
  const words = source.split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : source.slice(0, 2);
  return initials.toUpperCase() || '5C';
}

const NARROW_QUERY = '(max-width: 1100px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches;
const plainClick = (event: React.MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Destination href, so middle-click and copy-link keep working. */
export function destinationHref(target: WorkspaceDestination): string {
  const route: WorkspaceRoute = { section: target.section, tab: 'summary', report: target.report ?? 'rent-roll',
    ...(target.kind ? { kind: target.kind } : {}), ...(target.projectTab ? { projectTab: target.projectTab } : {}),
    ...(target.investorTab ? { investorTab: target.investorTab } : {}), ...(target.workOrderView ? { workOrderView: target.workOrderView } : {}),
    ...(target.accountingView ? { accountingView: target.accountingView } : {}), ...(target.reportId ? { reportId: target.reportId } : {}) };
  return `/ops${workspaceRouteSearch(route)}`;
}

export function TopNavigation({ route, onNavigate, transparency, onTransparency, source, accountLabel, onLogout }: {
  route: WorkspaceRoute; onNavigate: (destination: WorkspaceDestination) => void;
  transparency: Transparency; onTransparency: (value: Transparency) => void;
  source: 'live' | 'synthetic'; accountLabel?: string; onLogout: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const returnFocusToToggle = useRef(false);
  const activeGroup = activeNavigationGroup(route);
  const current = activeDestination(route);
  // Close menus when the view changes; background record selection (a replace of
  // the same view) must not dismiss a menu the manager is using.
  const viewKey = `${route.section}|${current?.id ?? ''}|${route.kind ?? ''}|${route.report}`;
  useLayoutEffect(() => { setOpenGroup(undefined); setMobileOpen(false); }, [viewKey]);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const reset = () => { setMobileOpen(false); setOpenGroup(undefined); };
    media.addEventListener('change', reset);
    return () => media.removeEventListener('change', reset);
  }, []);
  const choose = (target: WorkspaceDestination) => {
    returnFocusToToggle.current = isNarrow();
    setOpenGroup(undefined); setMobileOpen(false); onNavigate(target);
  };
  return <header className="rops-topbar" data-transparency={transparency}>
    <a className="rops-wordmark" href={destinationHref(DASHBOARD_DESTINATION)} onClick={event => {
      if (plainClick(event)) { event.preventDefault(); onNavigate(DASHBOARD_DESTINATION); }
    }} aria-label="5Central Ops dashboard"><span>5</span>Central Ops</a>
    <button ref={menuButton} className="rops-mobile-toggle" type="button" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} aria-controls="rops-primary-navigation" onClick={() => { setMobileOpen(value => !value); setOpenGroup(undefined); }}>
      <span className="rops-mobile-location">{activeGroup}{current && current.section !== 'dashboard' && <small>{current.label}</small>}</span>{mobileOpen ? <X size={18} aria-hidden="true"/> : <Menu size={18} aria-hidden="true"/>}
    </button>
    <nav id="rops-primary-navigation" className={`rops-primary-navigation${mobileOpen ? ' is-open' : ''}`} aria-label="Main navigation" onKeyDown={event => {
      if (event.key === 'Escape') {
        setOpenGroup(undefined);
        if (isNarrow()) { returnFocusToToggle.current = Boolean(openGroup); setMobileOpen(false); menuButton.current?.focus(); }
      }
    }}>
      {WORKSPACE_NAVIGATION.map(group => group.direct
        ? <a key={group.label} className="rops-nav-trigger rops-nav-direct" href={destinationHref(group.direct)} aria-current={activeGroup === group.label ? 'page' : undefined} onClick={event => {
          if (plainClick(event)) { event.preventDefault(); choose(group.direct!); }
        }}>{group.label}</a>
        : <Dropdown.Root key={group.label} modal={false} open={openGroup === group.label} onOpenChange={open => setOpenGroup(value => open ? group.label : value === group.label ? undefined : value)}>
          <Dropdown.Trigger className="rops-nav-trigger" aria-current={activeGroup === group.label ? 'true' : undefined}>
            {group.label}<ChevronDown size={12} aria-hidden="true"/>
          </Dropdown.Trigger>
          <Dropdown.Portal><Dropdown.Content className="rops-nav-menu" data-transparency={transparency} align="start" sideOffset={8} collisionPadding={16} loop onEscapeKeyDown={() => {
            setOpenGroup(undefined);
            if (isNarrow()) { returnFocusToToggle.current = true; setMobileOpen(false); }
          }} onCloseAutoFocus={event => {
            // Route effects and Radix dismissal can run in either order.
            if (returnFocusToToggle.current) { event.preventDefault(); menuButton.current?.focus(); returnFocusToToggle.current = false; }
          }}>
            {group.items.map(item => <Dropdown.Item className="rops-menu-item" key={item.id} data-destination={item.id} textValue={item.label}
              aria-current={current?.id === item.id ? 'page' : undefined} onSelect={() => choose(item)}>
              <span>{item.label}</span>{current?.id === item.id && <Check size={14} aria-hidden="true"/>}
            </Dropdown.Item>)}
          </Dropdown.Content></Dropdown.Portal>
        </Dropdown.Root>)}
    </nav>
    <AccountMenu transparency={transparency} onTransparency={onTransparency} source={source} accountLabel={accountLabel} onLogout={onLogout}/>
  </header>;
}

function AccountMenu({ transparency, onTransparency, source, accountLabel, onLogout }: {
  transparency: Transparency; onTransparency: (value: Transparency) => void; source: 'live' | 'synthetic'; accountLabel?: string; onLogout: () => void;
}) {
  return <Dropdown.Root modal={false}>
    <Dropdown.Trigger className="rops-account-trigger" aria-label={accountLabel ? `Account: ${accountLabel}` : 'Account'}>
      <span aria-hidden="true">{accountInitials(accountLabel)}</span>
    </Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content className="rops-nav-menu rops-account-menu" data-transparency={transparency} align="end" sideOffset={8} collisionPadding={16} loop>
      {accountLabel && <Dropdown.Label className="rops-menu-label rops-account-name">{accountLabel}</Dropdown.Label>}
      {source === 'synthetic' && <Dropdown.Label className="rops-menu-label">Synthetic development data</Dropdown.Label>}
      <Dropdown.Sub><Dropdown.SubTrigger className="rops-menu-item">Appearance<ChevronRight size={14} aria-hidden="true"/></Dropdown.SubTrigger>
        <Dropdown.Portal><Dropdown.SubContent className="rops-nav-menu" data-transparency={transparency} sideOffset={6} collisionPadding={16}>
          <Dropdown.Label className="rops-menu-label">Transparency</Dropdown.Label>
          <Dropdown.RadioGroup value={transparency} onValueChange={value => onTransparency(value as Transparency)}>
            {(['system', 'reduced'] as const).map(value => <Dropdown.RadioItem key={value} className="rops-menu-item" value={value}>
              {value === 'system' ? 'System' : 'Reduced'}<Dropdown.ItemIndicator><Check size={15} aria-hidden="true"/></Dropdown.ItemIndicator>
            </Dropdown.RadioItem>)}
          </Dropdown.RadioGroup>
        </Dropdown.SubContent></Dropdown.Portal>
      </Dropdown.Sub>
      <Dropdown.Item className="rops-menu-item" asChild><a href="/">5Central website</a></Dropdown.Item>
      <Dropdown.Item className="rops-menu-item" asChild><a href="/ops?ui=classic">Classic workspace</a></Dropdown.Item>
      <Dropdown.Separator className="rops-menu-separator"/>
      <Dropdown.Item className="rops-menu-item" onSelect={onLogout}>Sign out</Dropdown.Item>
    </Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}
