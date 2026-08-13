'use client';

import { useTranslation } from 'react-i18next';

/**
 * Shown when no project is open yet.
 *
 * Deliberately just a prompt and a button. This used to be a second, parallel
 * project browser — it listed the same projects as SessionBrowser but with its
 * own loading, search and expand logic, and without the modal's height
 * constraint, so with a realistic number of projects the list overflowed and
 * could not be scrolled at all. Rather than repair a duplicate, hand the job to
 * the browser that already works.
 */
interface EmptyStateProps {
  /** Open the project/session browser. */
  onBrowseProjects: () => void;
}

export function EmptyState({ onBrowseProjects }: EmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 bg-card">
      <svg
        className="w-14 h-14 text-muted-foreground/40"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        />
      </svg>

      <p className="text-sm text-muted-foreground">{t('workspace.selectProject')}</p>

      <button
        onClick={onBrowseProjects}
        className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 10v6m3-3H9m-4 7h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        {t('workspace.openProject')}
      </button>
    </div>
  );
}
