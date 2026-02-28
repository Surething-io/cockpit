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
 * 判断是否为 Cockpit iframe 的方式：
 * 1. URL 参数（快速路径）—— Cockpit 在 iframe src 上追加 _cockpit=1，
 *    content script 在 document_start 检查该参数，有则立即激活。
 * 2. background 追踪（重定向兜底）—— 服务端 302 重定向会丢失 URL 参数，
 *    background 通过 webNavigation.onBeforeNavigate 记录初始请求带 _cockpit=1 的 frame，
 *    content script 在参数缺失时异步查询 background 确认。
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[Cockpit Bridge]';

  // 顶层页面：仅在 Cockpit 页面设置安装标记
  if (window === window.top) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(window.location.origin)) {
      try {
        window.__cockpitBridge = { version: chrome.runtime.getManifest().version };
      } catch {
        window.__cockpitBridge = { version: 'unknown' };
      }
    }
    return;
  }

  // iframe 内 —— 通过 URL 参数 _cockpit=1 判断是否为 Cockpit 直属 iframe
  //
  // 保存真实 parent 引用（在伪装脚本覆盖之前，isolated world 不受影响）
  const realParent = window.parent;

  // 快速路径：检查 URL 参数（无重定向时直接命中）
  let hasCockpitParam = false;
  try {
    hasCockpitParam = new URL(window.location.href).searchParams.get('_cockpit') === '1';
  } catch { /* 忽略 */ }

  if (hasCockpitParam) {
    // URL 带 _cockpit=1，立即激活
    activateCockpitBridge();
  } else {
    // 慢速路径：服务端重定向可能丢失 _cockpit=1 参数
    // 向 background 查询当前 frame 是否在 webNavigation 追踪列表中
    chrome.runtime.sendMessage({ type: 'cockpit:check-frame' }, (response) => {
      if (response?.isCockpit) {
        console.log(LOG_PREFIX, '通过 background 追踪确认为 Cockpit frame（重定向场景）');
        activateCockpitBridge();
      }
    });
  }

  // ====================================================================
  // 以下代码只在 _cockpit=1 参数存在时执行
  // ====================================================================
  function activateCockpitBridge() {
    // ----------------------------------------------------------------
    // -1. 清理 URL 中的 _cockpit 参数，避免网站看到
    // ----------------------------------------------------------------
    try {
      const cleanUrl = new URL(window.location.href);
      if (cleanUrl.searchParams.has('_cockpit')) {
        cleanUrl.searchParams.delete('_cockpit');
        history.replaceState(history.state, '', cleanUrl.toString());
      }
    } catch (e) { /* 忽略 */ }

    console.log(LOG_PREFIX,
      `Cockpit iframe 激活: ${window.location.href}\n` +
      `  ├─ 伪装: window.top/parent/frameElement 已覆盖\n` +
      `  ├─ 拦截: target="_blank" 链接、window.open → 新气泡\n` +
      `  ├─ 监听: pushState/replaceState/popstate → URL 同步\n` +
      `  └─ Cookie: 请求 background 注入 SameSite=Lax/Strict Cookie`
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
    // 0.5 Cookie 注入：通知 background 为当前域名创建 Cookie 请求头规则
    //     不修改全局 Cookie，只在网络层注入请求头
    // ----------------------------------------------------------------
    try {
      chrome.runtime.sendMessage({ type: 'cockpit:inject-cookies', url: window.location.href });
    } catch (e) {
      // 忽略
    }

    const COCKPIT_MSG_PREFIX = 'cockpit:';

    // ----------------------------------------------------------------
    // 1. 向父页面发送消息（使用真实 parent 引用）
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
    // 2. 拦截 <a target="_blank"> 点击
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
    // 3. 重写 window.open → 拦截并通知
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
    // 4. 监听页面内导航（SPA pushState / replaceState / popstate）
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
    // 5. 页面加载完成后通知当前 URL
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
