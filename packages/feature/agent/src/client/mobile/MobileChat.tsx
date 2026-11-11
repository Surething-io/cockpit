'use client';

import { SessionTitle } from '../SessionTitle';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSessionEngineState } from '../effect';
import { useChatHistory } from '../useChatHistory';
import { useChatStream, NO_BG_TASKS } from '../useChatStream';
import { TaskStoreContext, createTaskStore } from '../taskStore';
import { useLiveStream } from '../useLiveStream';
import { MessageList, type MessageListHandle } from '../MessageList';
import { MobileChatInput } from './MobileChatInput';
import type { ChatEngine, EngineModelId, LiveOutputTokens, BackgroundTaskInfo } from '../types';

// Per-session engine + model + execution mode, persisted by the desktop tab system in the
// project's session.json. This is the same source useTabState resumes from —
// the reliable way to send ollama on its original model (the transcript doesn't
// record it, and the server otherwise falls back to a default).
interface ResolvedRun {
  engine?: ChatEngine;
  ollamaModel?: string;
  deepseekModel?: EngineModelId;
  kimiModel?: EngineModelId;
  glmModel?: EngineModelId;
  grokModel?: string;
  grokReasoningEffort?: string;
}

// Mobile chat surface for /m. Reuses the proven streaming orchestration from
// Chat.tsx (history + stream + live viewer) but with a touch-only shell: a back
// bar, the shared MessageList renderer, and the minimal MobileChatInput.
//
// Deliberately omitted vs desktop Chat: header/sidebar, PTY mode + floating
// window, plan-mode toggle, ollama/deepseek pickers, image paste, and the
// git/comments/note/scheduled-task buttons.
interface MobileChatProps {
  cwd: string;
  initialSessionId: string;
  initialTitle?: string;
  onBack: () => void;
  // Whether this chat screen is the one on-screen. Kept mounted (slid off-screen)
  // when false so swipe-back/forward never re-fetches history; forwarded to
  // MessageList, which re-scrolls to bottom when it becomes active again.
  isActive?: boolean;
}

export function MobileChat({ cwd, initialSessionId, initialTitle, onBack, isActive = true }: MobileChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(initialTitle ?? '');
  const [resolved, setResolved] = useState<ResolvedRun>({});
  const messageListRef = useRef<MessageListHandle>(null);

  // Resolve this session's persisted engine + model from session.json (same as
  // the desktop tab system). Runs once; failures are non-fatal (we fall back to
  // the engine echoed by history and the server's default model).
  useEffect(() => {
    BrowserRuntime.runPromiseExit(loadSessionEngineState(cwd)).then((exit) => {
      if (exit._tag === 'Success' && exit.value) {
        const d = exit.value;
        setResolved({
          engine: d.engines?.[initialSessionId] as ChatEngine | undefined,
          ollamaModel: d.ollamaModels?.[initialSessionId],
          deepseekModel: d.deepseekModels?.[initialSessionId] as EngineModelId | undefined,
          kimiModel: d.kimiModels?.[initialSessionId] as EngineModelId | undefined,
          glmModel: d.glmModels?.[initialSessionId] as EngineModelId | undefined,
          grokModel: d.grokModels?.[initialSessionId],
          grokReasoningEffort: d.grokReasoningEfforts?.[initialSessionId],
        });
      }
    });
  }, [cwd, initialSessionId]);

  // #10 (mirrors Chat.tsx): whether the live stream is currently rendering this
  // run, so the initial disk load defers to it instead of double-rendering.
  const [liveRunning, setLiveRunning] = useState(false);
  const [viewerLiveOutputTokens, setViewerLiveOutputTokens] = useState<LiveOutputTokens | null>(null);
  const [viewerRunStartedAt, setViewerRunStartedAt] = useState<number | null>(null);
  const [viewerBackgroundTasks, setViewerBackgroundTasks] = useState<BackgroundTaskInfo[]>(NO_BG_TASKS);
  // Mirrors Chat.tsx: live task state for every spawn depth, kept beside the message tree.
  const taskStore = useMemo(() => createTaskStore(), []);

  // History first — it yields the authoritative engine (echoed by /api/session-by-path).
  const {
    messages,
    recoveryCopies,
    onRecoveryDeleted,
    onLiveSnapshotStart,
    onWriterIdle,
    setRunMessages,
    onRunAccepted,
    onSendFailure,
    onInputRejected,
    onLiveRunEnd,
    onSenderStart,
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadedSessionId,
    loadedEngine,
    loadedBot,
  } = useChatHistory(sessionId, {
    enabled: isActive,
    liveRunning,
    reconcileLimit: null,
    cwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange: setTitle,
  });

  // Send on the session's native engine. Same precedence as Chat.tsx: what the transcript's
  // store proves outranks the persisted tab value (which is a cache and can be stale/wrong);
  // the persisted value only fills what the store can't tell.
  const engine: ChatEngine | undefined = loadedEngine ?? resolved.engine ?? undefined;

  const noop = useCallback(() => {}, []);
  const {
    drainingSubscriptions,
    isLoading,
    liveOutputTokens: streamLiveOutputTokens,
    runningStartedAt: streamRunningStartedAt,
    apiRetryInfo,
    backgroundTasks,
    handleSend,
    handleStop,
  } = useChatStream(messages, setRunMessages, {
    sessionId,
    cwd,
    engine,
    planMode: false,
    ollamaModel: resolved.ollamaModel,
    grokModel: resolved.grokModel,
    grokReasoningEffort: resolved.grokReasoningEffort,
    engineModel:
      engine === 'kimi'
        ? resolved.kimiModel
        : engine === 'glm'
          ? resolved.glmModel
          : resolved.deepseekModel,
    onSessionId: setSessionId,
    onFetchTitle: noop,
    onSendStart: onSenderStart,
    onRunAccepted,
    onSendFailure,
    onInputRejected,
    onRunEnd: onLiveRunEnd,
    onRecoveryDeleted,
    // Mirrors Chat.tsx: when a run this screen ORIGINATED ends, reconcile from disk so
    // temp live bubbles converge to canonical uuids — without this the next snapshot /
    // incremental load can double-render the turn on mobile.
    taskStore,
  });

  // Live viewer: tail the active run whenever we're viewing this session and not
  // the one currently sending. Lets a run started elsewhere (desktop / scheduled
  // task) stream live on the phone — the core "did it finish?" monitoring case.
  const liveSessionId = loadedSessionId || sessionId;
  const liveViewerEnabled = isActive && !isLoading && !!liveSessionId;
  useLiveStream(liveSessionId, setRunMessages, liveViewerEnabled, engine, {
    onSnapshotStart: onLiveSnapshotStart,
    onWriterIdle,

    onRunEnd: onLiveRunEnd,
    onRecoveryDeleted,
    onRunningChange: setLiveRunning,
    onLiveOutputTokens: setViewerLiveOutputTokens,
    onRunStartedAt: setViewerRunStartedAt,
    onBackgroundTasks: (tasks) => setViewerBackgroundTasks(tasks.length ? tasks : NO_BG_TASKS),
    taskStore,
  });
  useEffect(() => {
    if (!liveViewerEnabled) {
      setLiveRunning(false);
      setViewerLiveOutputTokens(null);
      setViewerRunStartedAt(null);
      setViewerBackgroundTasks(NO_BG_TASKS);
    }
  }, [liveViewerEnabled]);

  const isRunning = isLoading || liveRunning;
  const liveOutputTokens = isLoading ? streamLiveOutputTokens : liveRunning ? viewerLiveOutputTokens : null;
  const runningStartedAt = isLoading ? streamRunningStartedAt : liveRunning ? viewerRunStartedAt : null;
  const liveBackgroundTasks = isLoading ? backgroundTasks : liveRunning ? viewerBackgroundTasks : NO_BG_TASKS;

  // Mirrors Chat.tsx: a turn the person sent takes the viewport, anything the
  // transcript receives on its own does not. Matters more here than on desktop,
  // where the soft keyboard already leaves only a few lines of conversation
  // visible — a reply that pushes the question off the top has nowhere to
  // scroll back to one-handed.
  const onSend = useCallback((content: string) => {
    messageListRef.current?.pinNextUserMessage();
    handleSend(content);
  }, [handleSend]);

  return (
    <TaskStoreContext.Provider value={taskStore}>
    {drainingSubscriptions}
    <div className="flex h-[100dvh] flex-col bg-card">
      {/* Back bar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground active:bg-active"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium"><SessionTitle cwd={cwd} sessionId={sessionId || ''} title={title || '…'} editable={false} /></div>
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
            recoveryCopies={recoveryCopies}
          isLoading={isRunning}
          liveOutputTokens={liveOutputTokens}
          runningStartedAt={runningStartedAt}
          cwd={cwd}
          sessionId={sessionId}
          engine={engine}
          botName={loadedBot}
          apiRetryInfo={apiRetryInfo}
          backgroundTasks={liveBackgroundTasks}
          hasMoreHistory={hasMoreHistory}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreHistory}
          isActive={isActive}
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
    </TaskStoreContext.Provider>
  );
}
