'use client';

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { onSkillsChanged } from '@cockpit/shared-api';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSkills as loadSkillsEff, loadSlashCommands } from './effect/agentClient';

// ============================================
// Shared line-led `/` `@` command autocomplete for plain <textarea> hosts.
//
// Extracted from ChatInput so the scheduled-task composer can offer the same
// menu. Both hosts feed the SAME command+skill list, so adding a builtin or a
// skill can no longer show up in one composer and silently miss the other.
//
// Not to be confused with SlashCommandMenu.tsx — that one drives a TipTap
// editor (markdown block formatting) and shares nothing with this.
//
// Scope note: selection only splices `/<verb> ` back into the text. Expansion
// happens server-side in resolveCommandPrompt, which is on the dispatch path
// for typed chat messages AND for scheduled tasks alike — which is why this is
// meaningful in the scheduler, not just decoration.
// ============================================

export interface CommandInfo {
  name: string;
  description: string;
  // `'global' | 'project'` (`.claude/commands/*.md`) used to be valid sources;
  // that mechanism was retired with Claude Code's commands convention.
  source: 'builtin' | 'skill';
  // Only present when source === 'skill'
  skillPath?: string;
  argumentHint?: string;
}

interface SkillInfo {
  id: string;
  path: string;
  name: string;
  description: string;
  icon?: string;
  argumentHint?: string;
  valid: boolean;
}

interface UseCommandAutocompleteOptions {
  /** Current textarea text. */
  value: string;
  /** Called with the spliced text when a command is picked. */
  onChange: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Host-only entries merged ahead of the server list — e.g. ChatInput's
   * `/plan`, which is intercepted client-side in Chat.tsx and therefore must
   * NOT appear in hosts that don't implement it (the scheduler dispatch path
   * never reaches that interception, so a listed `/plan` would be a dead item).
   */
  extraCommands?: CommandInfo[];
}

export interface CommandAutocomplete {
  isOpen: boolean;
  items: CommandInfo[];
  selectedIndex: number;
  /** The marker the user actually typed (`/` or `@`), for faithful display. */
  marker: string;
  listRef: RefObject<HTMLDivElement | null>;
  selectCommand: (cmd: CommandInfo) => void;
  /**
   * Returns true when the key was consumed (and already had
   * preventDefault + stopPropagation applied). Hosts must bail out of their own
   * handling when it returns true.
   *
   * stopPropagation is deliberate: ScheduleTaskPopover listens for Escape and
   * Cmd+Enter on its ROOT div and the textarea's events bubble there, so
   * without it, dismissing the menu with Escape would close the whole dialog.
   */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Keep the caret offset in sync — call from onChange and onSelect. */
  trackCaret: (el: HTMLTextAreaElement) => void;
}

export function useCommandAutocomplete({
  value,
  onChange,
  textareaRef,
  extraCommands,
}: UseCommandAutocompleteOptions): CommandAutocomplete {
  const [caret, setCaret] = useState(value.length);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [skills, setSkills] = useState<CommandInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Start dismissed when the host opens with pre-filled text (editing an
  // existing scheduled task whose message is exactly `/qa` would otherwise pop
  // the menu open on mount). Any edit clears this.
  const [dismissed, setDismissed] = useState(() => value.length > 0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load command list (builtin only; project/global `.claude/commands/*.md`
  // sourcing was retired with Claude Code's commands convention)
  useEffect(() => {
    BrowserRuntime.runPromiseExit(loadSlashCommands<CommandInfo>()).then((exit) => {
      if (exit._tag === 'Success') {
        setCommands(exit.value as CommandInfo[]);
      } else {
        console.error('Failed to load commands:', exit.cause);
      }
    });
  }, []);

  // Load skills (separate endpoint, globally-configured, ~/.cockpit/skills.json)
  const loadSkills = useCallback(async () => {
    const exit = await BrowserRuntime.runPromiseExit(loadSkillsEff());
    if (exit._tag === 'Success') {
      const data = (exit.value as { skills?: SkillInfo[] }).skills
        ?? (exit.value as unknown as SkillInfo[]);
      const list = Array.isArray(data) ? data : [];
      const mapped: CommandInfo[] = list
        .filter((s) => s.valid && !!s.name)
        .map((s) => ({
          name: `/${s.name}`,
          description: s.description || '',
          source: 'skill' as const,
          skillPath: s.path,
          argumentHint: s.argumentHint,
        }));
      setSkills(mapped);
    } else {
      console.error('Failed to load skills:', exit.cause);
    }
  }, []);

  useEffect(() => {
    loadSkills();
    // Re-load when SkillsModal notifies the skills list changed
    return onSkillsChanged(loadSkills);
  }, [loadSkills]);

  // The line containing the caret — commands are line-led, so autocomplete keys
  // off the current line, not the whole (possibly multi-line) input.
  const activeLine = useMemo(() => {
    const lineStart = caret === 0 ? 0 : value.lastIndexOf('\n', caret - 1) + 1;
    const nl = value.indexOf('\n', caret);
    const lineEnd = nl === -1 ? value.length : nl;
    return { text: value.slice(lineStart, lineEnd), start: lineStart, end: lineEnd };
  }, [value, caret]);

  // The command being typed on the active line: a `/` or `@` marker followed by
  // a partial verb with nothing after it yet (a trailing space starts the body
  // and dismisses the menu). Marker-agnostic — `@qa` matches the same `/qa` entry.
  const commandQuery = useMemo(() => {
    // Verb char class kept in sync with the server (slashCommands' COMMAND_LINE_RE).
    const m = activeLine.text.match(/^\s*([/@])([a-zA-Z0-9-]*)$/);
    return m ? { marker: m[1], verb: m[2].toLowerCase() } : null;
  }, [activeLine.text]);

  // Command filtering: useMemo derived computation, eliminates setState churn per keystroke.
  // Commands first, then skills — grouped display preserves the two sections.
  const items = useMemo(() => {
    if (!commandQuery) return [];
    const { verb } = commandQuery;
    const match = (cmd: CommandInfo) => cmd.name.slice(1).toLowerCase().startsWith(verb);
    return [...(extraCommands ?? []).filter(match), ...commands.filter(match), ...skills.filter(match)];
  }, [commandQuery, extraCommands, commands, skills]);

  const isOpen = !dismissed && !!commandQuery && items.length > 0;

  // Reset selected index and dismiss state when the text changes
  const prevValueRef = useRef(value);
  useLayoutEffect(() => {
    if (prevValueRef.current !== value) {
      queueMicrotask(() => setSelectedIndex(0));
      if (dismissed) queueMicrotask(() => setDismissed(false));
      prevValueRef.current = value;
    }
  }, [value, dismissed]);

  // Scroll selected item into view
  useLayoutEffect(() => {
    if (isOpen && listRef.current) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, isOpen]);

  const trackCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? 0);
  }, []);

  const selectCommand = useCallback((command: CommandInfo) => {
    // Preserve the marker the user typed (`/` main session, `@` subagent); only
    // replace the command token on the active line, leaving other lines intact.
    const marker = commandQuery?.marker ?? '/';
    const insert = `${marker}${command.name.slice(1)} `;
    const before = value.slice(0, activeLine.start);
    const after = value.slice(activeLine.end);
    const pos = before.length + insert.length;
    onChange(before + insert + after);
    setCaret(pos);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }, [value, activeLine, commandQuery, onChange, textareaRef]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // IME composition (e.g. Chinese pinyin) must reach the textarea untouched.
    if (e.nativeEvent.isComposing) return false;
    if (!isOpen || items.length === 0) return false;

    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (e.key === 'ArrowDown') {
      consume();
      setSelectedIndex((prev) => (prev + 1) % items.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      consume();
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      consume();
      selectCommand(items[selectedIndex]);
      return true;
    }
    if (e.key === 'Escape') {
      // Soft dismiss (not a query clear) — and crucially, does NOT bubble to a
      // host dialog's close-on-Escape.
      consume();
      setDismissed(true);
      return true;
    }
    return false;
  }, [isOpen, items, selectedIndex, selectCommand]);

  return {
    isOpen,
    items,
    selectedIndex,
    marker: commandQuery?.marker ?? '/',
    listRef,
    selectCommand,
    handleKeyDown,
    trackCaret,
  };
}

// ============================================
// Menu
// ============================================

interface CommandAutocompleteMenuProps {
  ac: CommandAutocomplete;
  /** Positioning is the host's call — anchored above the chat bar, below the
   * scheduler textarea. Everything else (scroll, chrome) is shared. */
  className?: string;
}

export function CommandAutocompleteMenu({ ac, className = '' }: CommandAutocompleteMenuProps) {
  const { t } = useTranslation();
  const { isOpen, items, selectedIndex, marker, listRef, selectCommand } = ac;

  const getSourceLabel = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return t('common.builtin');
      case 'skill':
        return 'Skill';
    }
  };

  const getSourceColor = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return 'bg-brand/15 text-brand dark:bg-brand/25 dark:text-teal-11';
      case 'skill':
        return 'bg-purple-9/15 text-purple-11 dark:bg-purple-9/25 dark:text-purple-11';
    }
  };

  if (!isOpen || items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className={`overflow-y-auto bg-card border border-border rounded-lg shadow-lv2 ${className}`}
    >
      {items.map((cmd, index) => {
        const prev = index > 0 ? items[index - 1] : null;
        const isFirstSkill = cmd.source === 'skill' && (!prev || prev.source !== 'skill');
        const isFirstCommand = cmd.source !== 'skill' && index === 0;
        return (
          <div key={cmd.name}>
            {isFirstCommand && (
              <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                Commands
              </div>
            )}
            {isFirstSkill && (
              <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                Skills
              </div>
            )}
            <div
              onClick={() => selectCommand(cmd)}
              className={`px-4 py-2 cursor-pointer ${
                index === selectedIndex
                  ? 'bg-brand/10'
                  : 'hover:bg-hover'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-medium text-foreground">
                  {marker + cmd.name.slice(1)}
                </span>
                <span className="flex-1 text-sm text-muted-foreground truncate">
                  {cmd.source === 'builtin'
                    ? t(`commands.${cmd.name.slice(1)}`, { defaultValue: cmd.description })
                    : cmd.description}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${getSourceColor(cmd.source)}`}
                >
                  {getSourceLabel(cmd.source)}
                </span>
              </div>
              {cmd.source === 'skill' && cmd.argumentHint && (
                <div className="font-mono text-xs text-muted-foreground mt-0.5 pl-0 truncate">
                  {cmd.argumentHint}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
