/**
 * Cockpit Bridge - Background Service Worker
 *
 * iframe Cookie 注入：用 declarativeNetRequest 动态规则在网络层注入 Cookie 头
 * 不修改全局 Cookie 存储，只在请求层面补上 Cookie
 */

// =========================================================================
// iframe Cookie 注入
//
// 思路：iframe 跨站请求不带 SameSite=Lax Cookie。
// 用 chrome.cookies.getAll 读取目标域名的全部 Cookie，
// 通过 declarativeNetRequest 动态规则在网络层 set Cookie 请求头。
// 不修改 Cookie 存储，只影响请求头。
//
// 动态规则用 requestDomains 限定域名，tabIds 限定 Cockpit 标签页，
// resourceTypes 覆盖 sub_frame + 子资源（XHR/script/css/image 等）。
// =========================================================================

// 启动时清理上次残留的 session 规则（插件重载后内存中的 map 丢失，但规则仍生效）
chrome.declarativeNetRequest.getSessionRules().then(rules => {
  if (rules.length) {
    const ids = rules.map(r => r.id);
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    console.log(`[Cockpit Bridge] 启动清理: 移除 ${ids.length} 条残留 session 规则`);
  }
});

// =========================================================================
// Cockpit iframe 追踪 + Cookie 注入时序保证
//
// 双层保证机制：
//   Layer 1: externally_connectable（BrowserBubble → background 直连）
//     → await prepareCookies() 返回后才设置 iframe src
//     → Cookie 规则 100% 在首次请求前就绪
//
//   Layer 2: webNavigation.onBeforeNavigate（兜底 + frame 追踪）
//     → 记录带 _cockpit=1 的 frame，供 content script check-frame 查询
//     → 同时触发 injectCookiesForUrl 作为兜底（刷新场景等）
//
// DNR 静态规则 #3 在网络层剥离 _cockpit=1 参数，服务端永远看不到。
// =========================================================================
const cockpitFrames = new Set(); // "tabId-frameId"

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // 只关注 iframe（frameId > 0）
  if (details.frameId === 0) return;

  const key = `${details.tabId}-${details.frameId}`;

  if (details.url.includes('_cockpit=1')) {
    cockpitFrames.add(key);

    // 兜底注入：仅在 externally_connectable 未预创建规则时才触发
    // 避免重复调用 injectCookiesForUrl 导致「先删旧规则 → 异步创建新规则」的间隙
    try {
      const domain = new URL(details.url).hostname;
      const ruleKey = `${domain}:${details.tabId || 'all'}`;
      if (domainRuleMap.has(ruleKey)) {
        console.log(`[Cockpit Bridge] 追踪 frame: ${key}, Cookie 规则已由 prepare-iframe 创建，跳过`);
      } else {
        console.log(`[Cockpit Bridge] 追踪 frame: ${key}, 兜底创建 Cookie 规则`);
        injectCookiesForUrl(details.url, details.tabId);
      }
    } catch {
      injectCookiesForUrl(details.url, details.tabId);
    }
  }
});

// tab 关闭时清理该 tab 的所有记录
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of cockpitFrames) {
    if (key.startsWith(`${tabId}-`)) {
      cockpitFrames.delete(key);
    }
  }
});

// 已注入 Cookie 的域名 → rule ID 列表映射
let nextRuleId = 1000;
const domainRuleMap = new Map(); // "domain:tabId" → [ruleId, ruleId]


async function injectCookiesForUrl(url, tabId) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const key = `${domain}:${tabId || 'all'}`;

    // 已有规则则先清理
    if (domainRuleMap.has(key)) {
      const oldIds = domainRuleMap.get(key);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: oldIds,
      });
    }

    // 读取该域名及所有父域名的 Cookie
    // 例如 api.github.com 需要收集：
    //   domain=api.github.com  (精确匹配)
    //   domain=.github.com     (父域名，通过 getAll({ domain: 'github.com' }) 拿到)
    //   domain=.com 不需要（公共后缀，也不会有 Cookie）
    const domainParts = domain.split('.');
    const domainsToQuery = [];
    for (let i = 0; i < domainParts.length - 1; i++) {
      domainsToQuery.push(domainParts.slice(i).join('.'));
    }
    // 去重收集所有 Cookie
    const cookieMap = new Map(); // name+domain+path → cookie（去重）
    for (const d of domainsToQuery) {
      const result = await chrome.cookies.getAll({ domain: d });
      for (const c of result) {
        // 验证 Cookie 的 domain 确实能匹配当前域名
        // .github.com 匹配 api.github.com ✓
        // .example.com 不匹配 api.github.com ✗
        const cookieDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        if (domain === cookieDomain || domain.endsWith('.' + cookieDomain)) {
          cookieMap.set(`${c.name}|${c.domain}|${c.path}`, c);
        }
      }
    }
    const cookies = Array.from(cookieMap.values());
    if (!cookies.length) {
      console.log(`[Cockpit Bridge] ${domain}: 无 Cookie，不注入`);
      return;
    }

    // 筛选被浏览器拦截的 Cookie（Lax/Strict/未设置）
    // 浏览器只自动发送 SameSite=None 的，其余需要我们追加
    // 用 append 不会覆盖浏览器发的 None 版本，同名 Cookie 共存等同于正常顶层访问
    const blockedCookies = cookies.filter(c => c.sameSite !== 'none');

    if (!blockedCookies.length) {
      console.log(`[Cockpit Bridge] ${domain}: 全部 ${cookies.length} 条 Cookie 均为 SameSite=None（浏览器自动发送），不注入`);
      return;
    }

    // 按 Cookie 的生效域名分组
    // .google.com 的 Cookie → requestDomains: ['google.com']（覆盖 accounts.google.com 等所有子域名）
    // console.cloud.google.com 的 Cookie → requestDomains: ['console.cloud.google.com']
    const domainGroups = new Map(); // effectiveDomain → [cookie, ...]
    for (const c of blockedCookies) {
      const effectiveDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      if (!domainGroups.has(effectiveDomain)) {
        domainGroups.set(effectiveDomain, []);
      }
      domainGroups.get(effectiveDomain).push(c);
    }

    const SUB_RESOURCE_TYPES = [
      'xmlhttprequest', 'script', 'stylesheet', 'image',
      'font', 'media', 'websocket', 'other',
    ];

    const ruleIds = [];
    const logLines = [];

    for (const [effectiveDomain, groupCookies] of domainGroups) {
      const cookieStr = groupCookies.map(c => `${c.name}=${c.value}`).join('; ');

      const cookieAction = {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Cookie', operation: 'append', value: cookieStr },
        ],
      };

      // 规则 A: sub_frame（iframe 文档加载）
      const ruleIdA = nextRuleId++;
      const conditionA = {
        requestDomains: [effectiveDomain],
        resourceTypes: ['sub_frame'],
      };

      // 规则 B: 子资源（XHR/script/css 等，仅 iframe 内发起）
      const ruleIdB = nextRuleId++;
      const conditionB = {
        requestDomains: [effectiveDomain],
        resourceTypes: SUB_RESOURCE_TYPES,
        excludedInitiatorDomains: ['localhost', '127.0.0.1'],
      };

      if (tabId) {
        conditionA.tabIds = [tabId];
        conditionB.tabIds = [tabId];
      }

      ruleIds.push(ruleIdA, ruleIdB);

      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          { id: ruleIdA, priority: 2, action: cookieAction, condition: conditionA },
          { id: ruleIdB, priority: 2, action: cookieAction, condition: conditionB },
        ],
      });

      logLines.push(`  ├─ ${effectiveDomain}: ${groupCookies.length} 条 Cookie (覆盖所有子域名)`);
    }

    domainRuleMap.set(key, ruleIds);

    const noneCount = cookies.filter(c => c.sameSite === 'none').length;
    console.log(`[Cockpit Bridge] ${domain}: Cookie 注入规则已创建 (tab=${tabId || 'all'})\n` +
      `  ├─ 追加: ${blockedCookies.length} 条 (Lax/Strict/未设置), 分 ${domainGroups.size} 个域名组\n` +
      logLines.join('\n') + '\n' +
      `  ├─ 浏览器自动发送: ${noneCount} 条 SameSite=None\n` +
      `  └─ 范围: 仅 Cockpit 标签页，不影响其他标签页`
    );
  } catch (e) {
    console.warn('[Cockpit Bridge] Cookie 注入失败:', e);
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'cockpit:reload') {
    chrome.runtime.reload();
    return;
  }

  if (message.type === 'cockpit:inject-cookies') {
    const tabId = sender.tab ? sender.tab.id : null;
    injectCookiesForUrl(message.url, tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  // content script 查询当前 frame 是否为 Cockpit iframe（处理重定向场景）
  if (message.type === 'cockpit:check-frame') {
    const key = `${sender.tab?.id}-${sender.frameId}`;
    const isCockpit = cockpitFrames.has(key);
    console.log(`[Cockpit Bridge] check-frame: ${key} → ${isCockpit}`);
    sendResponse({ isCockpit });
    return;
  }

  // evaluate：在 main world 执行 JS（绕过页面 CSP 限制）
  // allFrames: true → 在所有 frame 中执行（解决跨域 iframe 访问问题）
  if (message.type === 'cockpit:evaluate') {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab ID available' });
      return;
    }
    const target = message.allFrames
      ? { tabId, allFrames: true }
      : { tabId, frameIds: [frameId] };
    chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: async (code) => {
        // Chrome extension messaging 在 sendResponse 的 structured clone 边界
        // 存在一个隐性约 8 KiB 的截断点（复现于 session 6910d071 的 evaluate
        // 输出精确停在 8192 字节）。为避免大结果被默默截掉，我们在 MAIN
        // world 里先评估结果；如果序列化后 > CHUNK_THRESHOLD，把完整负载
        // 暂存到页面 window 上的一个 Map，只把一个 descriptor 返回给上层。
        // cock-browser CLI 会识别这个 descriptor 并通过 evaluate_chunk
        // action 分块读取、拼回完整内容，对调用方透明。
        const CHUNK_THRESHOLD = 6000;

        const maybeChunk = (data) => {
          let serialized;
          const isString = typeof data === 'string';
          try {
            serialized = isString
              ? data
              : (data === null || data === undefined)
                ? ''
                : JSON.stringify(data);
          } catch {
            // 不可序列化（循环引用等）— 原样返回，让上层照原路径处理
            return { ok: true, data };
          }
          if (!serialized || serialized.length <= CHUNK_THRESHOLD) {
            return { ok: true, data };
          }
          const W = window;
          if (!W.__cockpit_eval_stash_v1__) W.__cockpit_eval_stash_v1__ = new Map();
          const stash = W.__cockpit_eval_stash_v1__;
          // 10 min GC：避免长会话页面堆积大 payload
          const cutoff = Date.now() - 10 * 60 * 1000;
          for (const [k, v] of stash) {
            if (v.created < cutoff) stash.delete(k);
          }
          const token =
            'ck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          stash.set(token, { payload: serialized, isString, created: Date.now() });
          return {
            ok: true,
            data: {
              __cockpit_chunked: true,
              token,
              totalBytes: serialized.length,
              isString,
            },
          };
        };

        // 层 1: 直接 eval — 覆盖表达式、多语句、IIFE、模板字面量等
        // eval 自动返回最后一个表达式的值（类似 CDP replMode）
        try {
          const result = (0, eval)(code);
          const data = result instanceof Promise ? await result : result;
          return maybeChunk(data);
        } catch (e1) {
          // 层 2: AsyncFunction fallback — 覆盖含顶层 await 的代码
          try {
            const AF = Object.getPrototypeOf(async function(){}).constructor;
            const data = await new AF(code)();
            return maybeChunk(data);
          } catch {
            return { ok: false, error: e1.message };
          }
        }
      },
      args: [message.js],
    })
      .then(results => {
        if (message.allFrames) {
          // 多 frame：收集所有非 undefined 结果
          const all = (results || [])
            .map((r, i) => ({ frameId: r.frameId, ...r.result }))
            .filter(r => r.ok && r.data !== undefined);
          sendResponse({ ok: true, data: all.length === 1 ? all[0].data : all });
        } else {
          const r = results?.[0]?.result;
          if (r?.ok) sendResponse({ ok: true, data: r.data });
          else sendResponse({ ok: false, error: r?.error || 'Execution failed' });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }

  // 截图：automation.js 请求截取当前标签页可见区域
  if (message.type === 'cockpit:capture-tab') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab ID available' });
      return;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }

});

// =========================================================================
// externally_connectable: Cockpit 页面直连通信
//
// BrowserBubble 在设置 iframe src 前，直接调用
//   chrome.runtime.sendMessage(extensionId, { type: 'prepare-iframe', url })
// 等待 Cookie 规则就绪后再渲染 iframe，彻底消除时序竞争。
// =========================================================================
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // 安全校验：只接受 localhost 消息
  if (!sender.url || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(sender.url)) {
    sendResponse({ ok: false, error: 'unauthorized' });
    return;
  }

  if (message.type === 'reload') {
    console.log('[Cockpit Bridge] externally_connectable: reload requested');
    sendResponse({ ok: true });
    chrome.runtime.reload();
    return;
  }

  if (message.type === 'prepare-iframe') {
    const tabId = sender.tab ? sender.tab.id : null;
    console.log(`[Cockpit Bridge] externally_connectable: prepare-iframe url=${message.url}, tabId=${tabId}`);
    injectCookiesForUrl(message.url, tabId).then(() => {
      sendResponse({ ok: true });
    });
    return true; // async sendResponse
  }

  sendResponse({ ok: false, error: 'unknown type' });
});

// =========================================================================
// [调试] onSendHeaders = 所有修改完成后、实际发送到服务器的最终头
//        extraHeaders = 才能看到 Cookie 头（Chrome 79+ 限制）
// =========================================================================
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.type !== 'sub_frame') return;

    const headers = {};
    for (const h of (details.requestHeaders || [])) {
      const name = h.name.toLowerCase();
      if (name.startsWith('sec-fetch-') || name === 'cookie') {
        headers[h.name] = name === 'cookie'
          ? `${(h.value || '').length} chars`
          : h.value;
      }
    }

    console.log(`[调试] sub_frame 最终请求头:\n` +
      `  URL: ${details.url}\n` +
      `  initiator: ${details.initiator || 'none'}\n` +
      `  tabId: ${details.tabId}\n` +
      `  headers: ${JSON.stringify(headers, null, 2)}`
    );
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);
