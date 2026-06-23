'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';
import { useChatHistory } from '../useChatHistory';
import { useChatStream } from '../useChatStream';
import { useLiveStream } from '../useLiveStream';
import { MessageList, type MessageListHandle } from '../MessageList';
import { MobileChatInput } from './MobileChatInput';
import type { ChatMessage, ChatEngine, DeepseekModel } from '../types';

// Per-session engine + model, persisted by the desktop tab system in the
// project's session.json. This is the same source useTabState resumes from —
// the reliable way to send ollama on its original model (the transcript doesn't
// record it, and the server otherwise falls back to a default).
interface ResolvedRun {
  engine?: ChatEngine;
  ollamaModel?: string;
  deepseekModel?: DeepseekModel;
}

// Mobile chat surface for /m. Reuses the proven streaming orchestration from
// Chat.tsx (history + stream + live viewer) but with a touch-only shell: a back
// bar, the shared MessageList renderer, and the minimal MobileChatInput.
//
// Deliberately omitted vs desktop Chat: header/sidebar, PTY mode + floating
// window, plan-mode toggle, ollama/deepseek pickers, image paste, and the
// git/comments/note/scheduled-task buttons. Always SDK mode.
interface MobileChatProps {
  cwd: string;
  initialSessionId: string;
  initialTitle?: string;
  onBack: () => void;
}

export function MobileChat({ cwd, initialSessionId, initialTitle, onBack }: MobileChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(initialTitle ?? '');
  const [resolved, setResolved] = useState<ResolvedRun>({});
  const messageListRef = useRef<MessageListHandle>(null);

  // Resolve this session's persisted engine + model from session.json (same as
  // the desktop tab system). Runs once; failures are non-fatal (we fall back to
  // the engine echoed by history and the server's default model).
  useEffect(() => {
    const eff = Effect.tryPromise({
      try: async () => {
        const res = await fetch(`/api/project-state?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) return null;
        return (await res.json()) as {
          engines?: Record<string, string>;
          ollamaModels?: Record<string, string>;
          deepseekModels?: Record<string, string>;
        };
      },
      catch: (cause) => new AppError({ message: 'loadProjectState failed', cause }),
    });
    BrowserRuntime.runPromiseExit(eff).then((exit) => {
      if (exit._tag === 'Success' && exit.value) {
        const d = exit.value;
        setResolved({
          engine: d.engines?.[initialSessionId] as ChatEngine | undefined,
          ollamaModel: d.ollamaModels?.[initialSessionId],
          deepseekModel: d.deepseekModels?.[initialSessionId] as DeepseekModel | undefined,
        });
      }
    });
  }, [cwd, initialSessionId]);

  // #10 (mirrors Chat.tsx): whether the live stream is currently rendering this
  // run, so the initial disk load defers to it instead of double-rendering.
  const [liveRunning, setLiveRunning] = useState(false);
  const liveRunningRef = useRef(false);
  useEffect(() => { liveRunningRef.current = liveRunning; }, [liveRunning]);

  // History first — it yields the authoritative engine (echoed by /api/session-by-path).
  const {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
    loadedEngine,
  } = useChatHistory(messages, setMessages, sessionId, {
    cwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange: setTitle,
    liveRunningRef,
  });

  // Send on the session's native engine: prefer the persisted tab engine, then
  // the engine echoed by history. undefined → claude.
  const engine: ChatEngine | undefined = resolved.engine ?? loadedEngine ?? undefined;

  const noop = useCallback(() => {}, []);
  const {
    isLoading,
    apiRetryInfo,
    ptyNotice,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd,
    engine,
    chatMode: 'sdk',
    planMode: false,
    ollamaModel: resolved.ollamaModel,
    deepseekModel: resolved.deepseekModel,
    onSessionId: setSessionId,
    onFetchTitle: noop,
  });

  // Live viewer: tail the active run whenever we're viewing this session and not
  // the one currently sending. Lets a run started elsewhere (desktop / scheduled
  // task) stream live on the phone — the core "did it finish?" monitoring case.
  const liveSessionId = loadedSessionId || sessionId;
  const liveViewerEnabled = !isLoading && !!liveSessionId;
  useLiveStream(liveSessionId, setMessages, liveViewerEnabled, engine, {
    onRunningChange: (r) => { liveRunningRef.current = r; setLiveRunning(r); },
    onComplete: () => {
      if (liveSessionId) loadHistoryByCwdAndSessionId(cwd, liveSessionId, true);
    },
  });
  useEffect(() => {
    if (!liveViewerEnabled) setLiveRunning(false);
  }, [liveViewerEnabled]);

  const isRunning = isLoading || liveRunning;

  const onSend = useCallback((content: string) => {
    handleSend(content);
  }, [handleSend]);

  return (
    <div className="flex h-[100dvh] flex-col bg-card">
      {/* Back bar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground active:bg-accent"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title || '…'}</div>
          <div className="truncate text-xs text-muted-foreground">{cwd.split('/').pop()}</div>
        </div>
      </div>

      {/* Messages */}
      {isLoadingHistory ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">…</div>
      ) : (
        <MessageList
          ref={messageListRef}
          messages={messages}
          isLoading={isRunning}
          cwd={cwd}
          sessionId={sessionId}
          engine={engine}
          apiRetryInfo={apiRetryInfo}
          ptyNotice={ptyNotice}
          hasMoreHistory={hasMoreHistory}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreHistory}
          isActive
        />
      )}

      {/* Composer */}
      <MobileChatInput
        onSend={onSend}
        onStop={handleStop}
        isRunning={isRunning}
        disabled={isRunning}
      />
    </div>
  );
}
