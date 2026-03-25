'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../shared/ThemeProvider';
import { toast } from '../shared/Toast';
import { isMacClient } from '@/lib/platform';
import { useCockpitBridge } from '@/hooks/useCockpitBridge';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const bridge = useCockpitBridge();
  const [extensionPath, setExtensionPath] = useState<string>('');
  const [appVersion, setAppVersion] = useState<string>('');

  // Language: 'en', 'zh', or 'auto' (use browser detection)
  const [language, setLanguageState] = useState<string>('auto');

  // Fetch current language setting from backend on open
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.language) setLanguageState(data.language); })
      .catch(() => {});
  }, [isOpen]);

  const handleLanguageChange = useCallback((lang: string) => {
    setLanguageState(lang);
    // Save to backend
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    }).catch(() => {});
    // Apply immediately
    const effective = lang === 'auto'
      ? (navigator.language.startsWith('zh') ? 'zh' : 'en')
      : lang;
    i18n.changeLanguage(effective);
  }, [i18n]);

  const extensionStatus = bridge ? 'installed' as const : 'not-installed' as const;
  const extensionVersion = bridge?.version ?? null;

  // Fetch app version
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/version')
      .then(r => r.json())
      .then(d => { if (d.version) setAppVersion(d.version); })
      .catch(() => {});
  }, [isOpen]);

  // Fetch extension directory path
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/extension/version')
      .then(r => r.json())
      .then(d => { if (d.path) setExtensionPath(d.path); })
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const themeOptions = [
    { value: 'system' as const, label: t('settings.themeSystem'), icon: '💻' },
    { value: 'light' as const, label: t('settings.themeLight'), icon: '☀️' },
    { value: 'dark' as const, label: t('settings.themeDark'), icon: '🌙' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-foreground">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Theme Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.theme')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                    theme === option.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border hover:border-slate-6 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="text-xl">{option.icon}</span>
                  <span className="text-xs font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Language Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.language')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: 'auto', label: t('settings.languageAuto'), icon: '🌐' },
                { value: 'en', label: 'English', icon: '🇺🇸' },
                { value: 'zh', label: '中文', icon: '🇨🇳' },
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleLanguageChange(option.value)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                    language === option.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border hover:border-slate-6 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="text-xl">{option.icon}</span>
                  <span className="text-xs font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Extension Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.browserExtension')}
            </label>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                  extensionStatus === 'installed' ? 'bg-green-500' : 'bg-slate-400'
                }`} />
                <span>
                  {extensionStatus === 'installed' && `${t('settings.extensionInstalled')}${extensionVersion ? ` (v${extensionVersion})` : ''}`}
                  {extensionStatus === 'not-installed' && t('settings.extensionNotInstalled')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('settings.extensionDescription')}
              </p>
              {extensionStatus !== 'installed' && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 space-y-1">
                  <p className="font-medium text-foreground">{t('settings.installSteps')}</p>
                  <p>{t('settings.step1')} <code className="px-1 py-0.5 bg-muted rounded text-foreground">chrome://extensions</code></p>
                  <p>{t('settings.step2')}</p>
                  <p>{t('settings.step3')}</p>
                  {isMacClient() && <p dangerouslySetInnerHTML={{ __html: t('settings.step4mac') }} />}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const path = extensionPath || 'chrome-extension';
                    navigator.clipboard.writeText(path);
                    toast(t('toast.copiedName', { name: path }));
                  }}
                  className="px-3 py-1.5 text-xs bg-brand text-white rounded-md hover:bg-brand/90 transition-colors"
                >
                  {t('settings.copyExtensionPath')}
                </button>
                {extensionStatus === 'installed' && (
                  <button
                    onClick={() => {
                      if (bridge?.id && (window as unknown as { chrome?: { runtime?: { sendMessage?: (id: string, msg: unknown) => void } } }).chrome?.runtime?.sendMessage) {
                        (window as unknown as { chrome: { runtime: { sendMessage: (id: string, msg: unknown) => void } } }).chrome.runtime.sendMessage(bridge.id, { type: 'reload' });
                        toast(t('toast.pluginReloading'));
                        // After reload, the content script re-injects window.__cockpitBridge
                        // useCockpitBridge will auto-update via the cockpit-bridge-ready event
                      }
                    }}
                    className="px-3 py-1.5 text-xs border border-border text-foreground rounded-md hover:bg-muted transition-colors"
                  >
                    {t('settings.reloadExtension')}
                  </button>
                )}
              </div>
              {extensionPath && (
                <p className="text-[11px] text-muted-foreground font-mono truncate">{extensionPath}</p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* About Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.about')}
            </label>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Cockpit{appVersion ? ` v${appVersion}` : ''}</p>
              <p className="text-muted-foreground/60">One seat. One AI. Everything under control.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
