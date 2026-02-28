/**
 * Cockpit Bridge - Content Script
 *
 * 注入到所有页面（包括 iframe 内），但只在 Cockpit 直属 iframe 中激活。
 *
 * 功能：
 * 1. 拦截 target="_blank" 链接点击 → postMessage 通知父页面创建新气泡
 * 2. 重写 window.open → postMessage 通知父页面创建新气泡
 * 3. 监听页面 URL 变化（pushState/replaceState/popstate）→ 通知父页面更新当前气泡 URL
 *
 * 识别 Cockpit iframe 的方式：
 * BrowserBubble 在 iframe src 上追加 _cockpit=1 参数，
 * DNR 静态规则在网络层剥离该参数（服务端看不到），
 * background 通过 webNavigation.onBeforeNavigate 记录带 _cockpit=1 的 frame，
 * content script 通过 check-frame 消息查询 background 确认身份。
 *
 * Cookie 预注入的方式：
 * BrowserBubble 通过 externally_connectable 直接调用 background 的 prepare-iframe，
 * await 返回后 Cookie 规则已就绪，再设置 iframe src。无时序竞争。
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[Cockpit Bridge]';

  // ====================================================================
  // 顶层页面：仅在 Cockpit 页面暴露 extension ID（供 externally_connectable 使用）
  // ====================================================================
  if (window === window.top) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(window.location.origin)) {
      // 注入到 main world，让页面 JS 能读取 extension ID
      const id = chrome.runtime.id;
      const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; } })();
      const script = document.createElement('script');
      script.textContent = `window.__cockpitBridge = { id: "${id}", version: "${version}" };`;
      (document.documentElement || document).prepend(script);
      script.remove();
    }
    return;
  }

  // ====================================================================
  // iframe 内：查询 background 确认是否为 Cockpit iframe
  // ====================================================================

  // 保存真实 parent 引用（在伪装脚本覆盖之前，isolated world 不受影响）
  const realParent = window.parent;

  // DNR 已在网络层剥离 _cockpit=1 参数，content script 看不到该参数。
  // 统一通过 background 的 cockpitFrames 追踪集合来确认身份。
  chrome.runtime.sendMessage({ type: 'cockpit:check-frame' }, (response) => {
    if (chrome.runtime.lastError) return; // 插件未就绪，忽略
    if (response?.isCockpit) {
      activateCockpitBridge();
    }
  });

  // ====================================================================
  // Bridge 激活逻辑
  // ====================================================================
  function activateCockpitBridge() {
    console.log(LOG_PREFIX,
      `Cockpit iframe 激活: ${window.location.href}\n` +
      `  ├─ 伪装: window.top/parent/frameElement 已覆盖\n` +
      `  ├─ 拦截: target="_blank" 链接、window.open → 新气泡\n` +
      `  ├─ 监听: pushState/replaceState/popstate → URL 同步\n` +
      `  └─ Cookie: 由 externally_connectable 预注入，无时序竞争`
    );

    // ----------------------------------------------------------------
    // 0. 伪装为顶层窗口（注入到页面 main world）
    //    让网站的 JS 无法检测到自己在 iframe 内
    // ----------------------------------------------------------------
    const disguiseScript = document.createElement('script');
    disguiseScript.textContent = `(function(){
      try {
        Object.defineProperty(window, 'top', { get: function() { return window; } });
        Object.defineProperty(window, 'parent', { get: function() { return window; } });
        Object.defineProperty(window, 'frameElement', { get: function() { return null; } });
      } catch(e) {}
    })();`;
    (document.documentElement || document).prepend(disguiseScript);
    disguiseScript.remove();

    // ----------------------------------------------------------------
    // 1. Cookie 补充注入：SPA 导航后域名可能变化，通知 background 补充规则
    //    首次加载的 Cookie 已由 externally_connectable 预注入
    // ----------------------------------------------------------------

    const COCKPIT_MSG_PREFIX = 'cockpit:';

    // ----------------------------------------------------------------
    // 2. 向父页面发送消息（使用真实 parent 引用）
    // ----------------------------------------------------------------
    function notifyParent(type, data) {
      try {
        const msg = { type: COCKPIT_MSG_PREFIX + type, ...data };
        realParent.postMessage(msg, '*');
        console.log(LOG_PREFIX, '→ postMessage', type, data);
      } catch (e) {
        console.warn(LOG_PREFIX, 'postMessage 失败', e);
      }
    }

    // ----------------------------------------------------------------
    // 3. 拦截 <a target="_blank"> 点击
    // ----------------------------------------------------------------
    document.addEventListener(
      'click',
      function (e) {
        let anchor = e.target;
        while (anchor && anchor.tagName !== 'A') {
          anchor = anchor.parentElement;
        }
        if (!anchor) return;

        const href = anchor.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;

        const target = anchor.target;
        if (target === '_blank' || (target && target !== '_self' && target !== '_top' && target !== '_parent')) {
          e.preventDefault();
          e.stopPropagation();
          console.log(LOG_PREFIX, '拦截新标签链接:', href);
          notifyParent('new-tab', { url: href });
        }
      },
      true,
    );

    // ----------------------------------------------------------------
    // 4. 重写 window.open → 拦截并通知
    // ----------------------------------------------------------------
    const originalOpen = window.open;
    window.open = function (url, target, features) {
      if (url) {
        let absoluteUrl;
        try {
          absoluteUrl = new URL(url, window.location.href).href;
        } catch {
          absoluteUrl = url;
        }
        console.log(LOG_PREFIX, '拦截 window.open:', absoluteUrl);
        notifyParent('new-tab', { url: absoluteUrl });
        return null;
      }
      return originalOpen.call(this, url, target, features);
    };

    // ----------------------------------------------------------------
    // 5. 监听页面内导航（SPA pushState / replaceState / popstate）
    // ----------------------------------------------------------------
    let lastUrl = window.location.href;

    function checkUrlChange() {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        console.log(LOG_PREFIX, 'URL 变化:', lastUrl, '→', currentUrl);
        lastUrl = currentUrl;
        notifyParent('navigate', { url: currentUrl });
        // URL 变化时重新注入 Cookie（可能域名或路径 Cookie 不同）
        try {
          chrome.runtime.sendMessage({ type: 'cockpit:inject-cookies', url: currentUrl });
        } catch (e) { /* 忽略 */ }
      }
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      checkUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      checkUrlChange();
    };

    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('hashchange', checkUrlChange);

    // ----------------------------------------------------------------
    // 6. 页面加载完成后通知当前 URL
    // ----------------------------------------------------------------
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        notifyParent('loaded', { url: window.location.href });
      });
    } else {
      notifyParent('loaded', { url: window.location.href });
    }
  }
})();
