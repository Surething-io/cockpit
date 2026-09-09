'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Where a focused Chat should render its composer.
 *
 * Side-by-side puts two live Chats on screen and each owns a ChatInput, so the
 * panel grew two composers. Hiding one in place fixed the count but not the
 * layout: the composer still occupied its pane's column, so the focused pane
 * ended lower than its neighbour and the two token bars sat at different
 * heights. The composer has to leave the panes entirely.
 *
 * It moves by portal rather than by being lifted out of Chat, because lifting
 * it would mean lifting everything it is wired to: cwd, engine, the
 * git/comments/notes/scheduled-task callbacks, the slash-command autocomplete.
 * All of that is per-session state Chat already owns.
 *
 * The catch a portal brings is that changing its container is an unmount and
 * remount, which is why ChatInput's draft and pending images are held by Chat
 * (see its `draft` / `setDraft` props) instead of locally. Everything else in
 * there is a transient popover and is meant to close on a focus change anyway.
 *
 * Null — the default, and always in single-pane mode — means "render in place".
 */
const ComposerSlotContext = createContext<HTMLElement | null>(null);

export function ComposerSlotProvider({
  value,
  children,
}: {
  value: HTMLElement | null;
  children: ReactNode;
}) {
  return <ComposerSlotContext.Provider value={value}>{children}</ComposerSlotContext.Provider>;
}

export function useComposerSlot(): HTMLElement | null {
  return useContext(ComposerSlotContext);
}

