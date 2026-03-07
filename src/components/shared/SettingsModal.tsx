'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '../shared/ThemeProvider';
import { toast } from '../shared/Toast';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [extensionStatus, setExtensionStatus] = useState<'checking' | 'installed' | 'not-installed'>('checking');
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [extensionPath, setExtensionPath] = useState<string>('');

  // 检测插件是否已安装 + 获取路径
  useEffect(() => {
    if (!isOpen) return;
    // 检查 content script 注入的 DOM dataset
    const bridgeId = document.documentElement?.dataset?.cockpitBridgeId;
    const bridgeVersion = document.documentElement?.dataset?.cockpitBridgeVersion;
    if (bridgeId) {
      setExtensionStatus('installed');
      setExtensionVersion(bridgeVersion || null);
    } else {
      setExtensionStatus('not-installed');
    }
    // 获取插件目录路径
    fetch('/api/extension/version')
      .then(r => r.json())
      .then(d => { if (d.path) setExtensionPath(d.path); })
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const themeOptions = [
    { value: 'light' as const, label: '浅色', icon: '☀️' },
    { value: 'dark' as const, label: '深色', icon: '🌙' },
    { value: 'system' as const, label: '跟随系统', icon: '💻' },
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
          <h2 className="text-sm font-medium text-foreground">设置</h2>
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
              主题
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

          {/* Extension Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              浏览器插件
            </label>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                  extensionStatus === 'installed' ? 'bg-green-500' :
                  extensionStatus === 'checking' ? 'bg-yellow-500 animate-pulse' :
                  'bg-slate-400'
                }`} />
                <span>
                  {extensionStatus === 'checking' && '检测中...'}
                  {extensionStatus === 'installed' && `Cockpit Bridge 已安装${extensionVersion ? ` (v${extensionVersion})` : ''}`}
                  {extensionStatus === 'not-installed' && 'Cockpit Bridge 未安装'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                安装 Chrome 插件后，iframe 内的链接跳转将被拦截：新标签链接创建新气泡，页面内导航更新当前气泡。
              </p>
              {extensionStatus !== 'installed' && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 space-y-1">
                  <p className="font-medium text-foreground">安装步骤：</p>
                  <p>1. 打开 Chrome 地址栏输入 <code className="px-1 py-0.5 bg-muted rounded text-foreground">chrome://extensions</code></p>
                  <p>2. 开启右上角「开发者模式」</p>
                  <p>3. 点击「加载已解压的扩展程序」</p>
                  <p>4. 选择下方路径目录</p>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const path = extensionPath || '项目根目录/chrome-extension';
                    navigator.clipboard.writeText(path);
                    toast(`已复制: ${path}`);
                  }}
                  className="px-3 py-1.5 text-xs bg-brand text-white rounded-md hover:bg-brand/90 transition-colors"
                >
                  复制插件目录路径
                </button>
                {extensionStatus === 'installed' && (
                  <button
                    onClick={() => {
                      const extId = document.documentElement?.dataset?.cockpitBridgeId;
                      if (extId && (window as any).chrome?.runtime?.sendMessage) {
                        (window as any).chrome.runtime.sendMessage(extId, { type: 'reload' });
                        toast('插件重载中...');
                        // 重载后 content script 会重新注入，短暂显示未安装
                        setExtensionStatus('checking');
                        setTimeout(() => {
                          const newId = document.documentElement?.dataset?.cockpitBridgeId;
                          setExtensionStatus(newId ? 'installed' : 'not-installed');
                          if (newId) {
                            const v = document.documentElement?.dataset?.cockpitBridgeVersion;
                            setExtensionVersion(v || null);
                          }
                        }, 1500);
                      }
                    }}
                    className="px-3 py-1.5 text-xs border border-border text-foreground rounded-md hover:bg-muted transition-colors"
                  >
                    重载插件
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
              关于
            </label>
            <div className="text-xs text-muted-foreground">
              <p>Cockpit - One seat. One AI. Everything under control.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
