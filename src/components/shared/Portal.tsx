'use client';

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Unified Portal component with built-in SSR safety guard and panel-aware mounting.
 *
 * Behavior:
 * - When rendered inside a `<PanelPortalProvider>`, children are portaled into
 *   that panel's container. The container lives inside the swipeable panel
 *   subtree, so any `position: fixed` overlay naturally follows the panel's
 *   `translateX` transform when the user swipes between views.
 * - When rendered outside any provider (e.g. global toasts, review mode),
 *   children fall back to `document.body`.
 *
 * Uses useSyncExternalStore instead of useState+useEffect to synchronously
 * obtain document.body on first client render, avoiding extra render cycles
 * and child ref timing issues.
 */

const noop = () => () => {};
const getBody = () => document.body;
const getNull = () => null as HTMLElement | null;

const PanelPortalContext = createContext<HTMLElement | null>(null);

export function Portal({ children }: { children: ReactNode }) {
  const panelContainer = useContext(PanelPortalContext);
  const bodyContainer = useSyncExternalStore(noop, getBody, getNull);
  const container = panelContainer ?? bodyContainer;

  if (!container) return null;
  return createPortal(children, container);
}

/**
 * Provides a panel-local portal target so that overlays inside a panel follow
 * the panel's swipe transform.
 *
 * Implementation notes:
 * - The wrapper sets `transform: translateZ(0)` to create a containing block
 *   for descendants with `position: fixed`. This means existing modal markup
 *   like `fixed inset-0` automatically anchors to the panel area instead of
 *   the viewport, so the backdrop covers only this panel.
 * - The portal target is `absolute inset-0 pointer-events-none`, with
 *   `[&>*]:pointer-events-auto` so direct children (modal roots) regain
 *   interactivity. When empty, the target does not block clicks on the panel
 *   beneath it.
 */
export function PanelPortalProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return (
    <div className="relative w-full h-full" style={{ transform: 'translateZ(0)' }}>
      <PanelPortalContext.Provider value={container}>
        {children}
      </PanelPortalContext.Provider>
      <div
        ref={setContainer}
        className="absolute inset-0 pointer-events-none [&>*]:pointer-events-auto"
      />
    </div>
  );
}

/**
 * Returns the active panel-portal target if one is provided by an ancestor,
 * otherwise `null`. Useful for components that call `createPortal` directly
 * and want to opt into panel-aware mounting without going through `<Portal>`.
 */
export function usePanelPortalTarget(): HTMLElement | null {
  return useContext(PanelPortalContext);
}
