import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronRight, Menu, X } from 'lucide-react';
import { activeNavigationGroup, WORKSPACE_NAVIGATION, type WorkspaceDestination } from './navigation';
import type { WorkspaceRoute } from './workspace-state';

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

export function TopNavigation({ route, onNavigate, transparency, onTransparency, source, onLogout }: {
  route: WorkspaceRoute; onNavigate: (destination: WorkspaceDestination) => void;
  transparency: Transparency; onTransparency: (value: Transparency) => void;
  source: 'live' | 'synthetic'; onLogout: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const returnFocusToToggle = useRef(false);
  const activeGroup = activeNavigationGroup(route);
  useLayoutEffect(() => { setOpenGroup(undefined); setMobileOpen(false); }, [route]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const reset = () => { setMobileOpen(false); setOpenGroup(undefined); };
    media.addEventListener('change', reset);
    return () => media.removeEventListener('change', reset);
  }, []);
  return <header className="rops-topbar" data-transparency={transparency}>
    <a className="rops-wordmark" href="/ops?section=dashboard" onClick={event => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); onNavigate({ label: 'Dashboard', section: 'dashboard' });
      }
    }} aria-label="5Central dashboard"><span>5</span>CENTRAL</a>
    <button ref={menuButton} className="rops-mobile-toggle" type="button" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} aria-controls="rops-primary-navigation" onClick={() => { setMobileOpen(value => !value); setOpenGroup(undefined); }}>
      <span>{activeGroup}</span>{mobileOpen ? <X size={18}/> : <Menu size={18}/>}
    </button>
    <nav id="rops-primary-navigation" className={`rops-primary-navigation${mobileOpen ? ' is-open' : ''}`} aria-label="Main navigation" onKeyDown={event => {
      if (event.key === 'Escape') {
        setOpenGroup(undefined);
        if (window.matchMedia('(max-width: 1100px)').matches) {
          returnFocusToToggle.current = Boolean(openGroup); setMobileOpen(false); menuButton.current?.focus();
        }
      }
    }}>
      {WORKSPACE_NAVIGATION.map(group => <Dropdown.Root key={group.label} modal={false} open={openGroup === group.label} onOpenChange={open => setOpenGroup(current => open ? group.label : current === group.label ? undefined : current)}>
        <Dropdown.Trigger className="rops-nav-trigger" aria-current={activeGroup === group.label ? 'true' : undefined}>
          {group.label}<ChevronDown size={12} aria-hidden="true"/>
        </Dropdown.Trigger>
        <Dropdown.Portal><Dropdown.Content className="rops-nav-menu" data-transparency={transparency} align="start" sideOffset={8} collisionPadding={16} loop onEscapeKeyDown={() => {
          setOpenGroup(undefined);
          if (window.matchMedia('(max-width: 1100px)').matches) { returnFocusToToggle.current = true; setMobileOpen(false); }
        }} onCloseAutoFocus={event => {
          // Route effects and Radix dismissal can run in either order.
          if (returnFocusToToggle.current) { event.preventDefault(); menuButton.current?.focus(); returnFocusToToggle.current = false; }
        }}>
          {group.items.map(item => <Dropdown.Item className="rops-menu-item" key={item.label} disabled={!item.section} textValue={item.label} onSelect={() => {
            returnFocusToToggle.current = window.matchMedia('(max-width: 1100px)').matches;
            setOpenGroup(undefined); setMobileOpen(false); onNavigate(item);
          }}>
            <span>{item.label}</span>{!item.section && <span className="rops-menu-status">Planned</span>}
          </Dropdown.Item>)}
          {group.label === 'Company' && <>
            <Dropdown.Separator className="rops-menu-separator"/>
            <Dropdown.Sub><Dropdown.SubTrigger className="rops-menu-item">Appearance<ChevronRight size={14}/></Dropdown.SubTrigger>
              <Dropdown.Portal><Dropdown.SubContent className="rops-nav-menu" data-transparency={transparency} sideOffset={6} collisionPadding={16}>
                <Dropdown.Label className="rops-menu-label">Transparency</Dropdown.Label>
                <Dropdown.RadioGroup value={transparency} onValueChange={value => onTransparency(value as Transparency)}>
                  {(['system', 'reduced'] as const).map(value => <Dropdown.RadioItem key={value} className="rops-menu-item" value={value}>
                    {value === 'system' ? 'System' : 'Reduced'}<Dropdown.ItemIndicator><Check size={15}/></Dropdown.ItemIndicator>
                  </Dropdown.RadioItem>)}
                </Dropdown.RadioGroup>
              </Dropdown.SubContent></Dropdown.Portal>
            </Dropdown.Sub>
            <Dropdown.Item className="rops-menu-item" asChild><a href="/ops?ui=classic">Classic workspace</a></Dropdown.Item>
            <Dropdown.Item className="rops-menu-item" asChild><a href="/">5Central website</a></Dropdown.Item>
            <Dropdown.Separator className="rops-menu-separator"/>
            {source === 'synthetic' && <Dropdown.Label className="rops-menu-label">Synthetic development data</Dropdown.Label>}
            <Dropdown.Item className="rops-menu-item" onSelect={onLogout}>Sign out</Dropdown.Item>
          </>}
        </Dropdown.Content></Dropdown.Portal>
      </Dropdown.Root>)}
    </nav>
  </header>;
}
