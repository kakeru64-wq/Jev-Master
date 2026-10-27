const DEFAULTS = { enabled: true, threshold: 0.8, disabledHosts: [] };
const $ = (id) => document.getElementById(id);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname; } catch {}

  const s = await chrome.storage.local.get(DEFAULTS);
  $("enabled").checked = s.enabled;
  $("site").checked = s.disabledHosts.includes(host);
  $("site").disabled = !host;
  $("threshold").value = s.threshold;
  $("thv").textContent = Number(s.threshold).toFixed(2);

  $("enabled").addEventListener("change", (e) => chrome.storage.local.set({ enabled: e.target.checked }));

  $("site").addEventListener("change", async (e) => {
    const { disabledHosts } = await chrome.storage.local.get(DEFAULTS);
    const next = disabledHosts.filter((h) => h !== host);
    if (e.target.checked) next.push(host);
    chrome.storage.local.set({ disabledHosts: next });
  });

  $("threshold").addEventListener("input", (e) => ($("thv").textContent = Number(e.target.value).toFixed(2)));
  $("threshold").addEventListener("change", (e) => chrome.storage.local.set({ threshold: Number(e.target.value) }));

  const refreshCount = () =>
    chrome.runtime.sendMessage({ type: "getCount", tabId: tab.id }, (r) => ($("count").textContent = r?.count ?? 0));
  refreshCount();
  setInterval(refreshCount, 1000);

  chrome.runtime.sendMessage({ type: "health" }, (r) => {
    const el = $("status");
    if (r?.ok) { el.textContent = `接続OK (${r.model})`; el.className = "status ok"; }
    else { el.textContent = "未接続 — npm start を実行"; el.className = "status ng"; }
  });
})();
