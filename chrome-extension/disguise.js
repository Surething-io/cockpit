/**
 * 伪装为顶层窗口（注入到 iframe 的 main world）
 * 让网站 JS 无法检测到自己在 iframe 内
 *
 * 由 content.js 通过 <script src="chrome-extension://xxx/disguise.js"> 加载，
 * 绕过 CSP 对内联脚本的限制。
 */
(function () {
  try {
    Object.defineProperty(window, 'top', { get: function () { return window; } });
    Object.defineProperty(window, 'parent', { get: function () { return window; } });
    Object.defineProperty(window, 'frameElement', { get: function () { return null; } });
  } catch (e) { /* ignore */ }
})();
