'use client';

interface ConsoleScrollButtonsProps {
  showTop: boolean;
  showBottom: boolean;
  onScrollTop: () => void;
  onScrollBottom: () => void;
}

export function ConsoleScrollButtons({ showTop, showBottom, onScrollTop, onScrollBottom }: ConsoleScrollButtonsProps) {
  return (
    <>
      {showTop && (
        <button
          onClick={onScrollTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95 z-10"
          title="跳转到开始"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
      {showBottom && (
        <button
          onClick={onScrollBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95 z-10"
          title="跳转到最新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    </>
  );
}
