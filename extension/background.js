// content script → ローカル中継サーバーへの橋渡し。
// ページの CSP / 混在コンテンツ制限を避けるため fetch は必ずここで行う。
const SERVER = "http://127.0.0.1:8787";
const hiddenCounts = new Map(); // tabId -> count

function setBadge(tabId) {
  const n = hiddenCounts.get(tabId) || 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d33" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === "classify") {
    fetch(`${SERVER}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: msg.host, items: msg.items }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => sendResponse({ ok: true, results: data.results }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期で sendResponse する
  }

  if (msg.type === "hidden" && tabId != null) {
    hiddenCounts.set(tabId, msg.count);
    setBadge(tabId);
  }

  if (msg.type === "getCount") {
    sendResponse({ count: hiddenCounts.get(msg.tabId) || 0 });
  }

  if (msg.type === "health") {
    fetch(`${SERVER}/health`)
      .then((r) => r.json())
      .then((d) => sendResponse(d))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => hiddenCounts.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    hiddenCounts.delete(tabId);
    setBadge(tabId);
  }
});
