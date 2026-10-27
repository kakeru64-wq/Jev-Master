// Jev Ad Filter content script
// 1) ヒューリスティックで広告候補を抽出 → 2) 既知広告ドメインは即非表示
// 3) 残りを Jev で判定 → しきい値以上を非表示
(() => {
  const BATCH = 20;
  const DEBOUNCE_MS = 500;
  const TEXT_LIMIT = 400;
  const HIDDEN_ATTR = "data-jev-hidden";
  const LOG = (...a) => console.debug("[Jev]", ...a);

  const AD_DOMAINS = [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.",
    "googletagservices.com", "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net",
    "taboola.com", "outbrain.com", "popin.cc", "logly.co.jp", "i-mobile.co.jp", "microad.jp",
    "adingo.jp", "impact-ad.jp", "ad-stir.com", "yads.yahoo.co.jp", "yimg.jp/images/listing",
    "adsrvr.org", "rubiconproject.com", "pubmatic.com", "openx.net", "smartadserver.com",
  ];
  const ATTR_RE = /(^|[\s_-])(ads?|adv|advert\w*|adslot|adunit|banner|sponsor\w*|promo\w*|pr|dfp|gpt-ad|taboola|outbrain|yads)(?=$|[\s_-])/i;
  const CAMEL_RE = /(^|[\s_-]|[a-z])(Ad|Ads|Advert|Banner|Sponsor|Sponsored|Promo)(?=$|[\s_-]|[A-Z0-9])|(^|[\s_-])ads?(?=[A-Z0-9])/;
  const LABEL_RE = /^\s*(広告|PR|ＰＲ|AD|Ad|スポンサー(リンク)?|Sponsored|Advertisement|プロモーション)\s*$/;
  const SKIP_TAGS = new Set(["HTML", "BODY", "MAIN", "HEADER", "NAV", "SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "svg"]);

  let settings = { enabled: true, threshold: 0.8, disabledHosts: [] };
  const checked = new WeakSet();    // Jev に送信済み
  const scores = new Map();         // element -> ad 確率（しきい値変更時の再評価用）
  let hiddenCount = 0;
  let timer = null;
  let observer = null;

  const host = location.hostname;
  const isActive = () => settings.enabled && !settings.disabledHosts.includes(host);

  const isAdUrl = (url) => !!url && AD_DOMAINS.some((d) => url.includes(d));

  function hide(el, reason) {
    if (el.hasAttribute(HIDDEN_ATTR)) return;
    el.setAttribute(HIDDEN_ATTR, reason);
    el.style.setProperty("display", "none", "important");
    hiddenCount++;
    report();
  }

  function unhideAll() {
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
      el.removeAttribute(HIDDEN_ATTR);
      el.style.removeProperty("display");
    });
    hiddenCount = 0;
    report();
  }

  function report() {
    chrome.runtime.sendMessage({ type: "hidden", count: hiddenCount }).catch(() => {});
  }

  function sizeOk(el) {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 30 * 30) return false;               // 極小（未描画スロット等）
    if (r.height > window.innerHeight * 2.5) return false;          // 巨大コンテナ
    if (r.width * r.height > window.innerWidth * window.innerHeight * 0.8) return false;
    return true;
  }

  function attrText(el) {
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    return `${el.id || ""} ${cls} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-ad-slot") ? "ad-slot" : ""}`;
  }

  const isAdAttr = (el) => {
    const t = attrText(el);
    return ATTR_RE.test(t) || CAMEL_RE.test(t);
  };

  // 描画されている極小要素（＝バッジ）。display:none 等でサイズ 0 のものは含めない
  const isTiny = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width * r.height < 30 * 30;
  };

  // 「広告」「PR」ラベル・バッジ要素から、広告本体らしい祖先ブロックを探す。
  // インフィード広告（一覧の 1 行）は行要素を優先し、一覧全体を巻き込まない。
  function labelContainer(label) {
    const row = label.closest("li, article, tr, dd");
    if (row && !SKIP_TAGS.has(row.tagName)) return row;
    let el = label.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName)) return null;
      const r = el.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 50) return el;
    }
    return null;
  }

  function collectCandidates() {
    const set = new Set();
    const add = (el) => {
      if (!el || SKIP_TAGS.has(el.tagName) || checked.has(el)) return;
      if (el.closest(`[${HIDDEN_ATTR}]`)) return;
      set.add(el);
    };

    document.querySelectorAll("iframe, ins.adsbygoogle, ins[data-ad-client]").forEach((el) => {
      if (el.tagName === "IFRAME" && isAdUrl(el.src)) {
        if (!el.closest(`[${HIDDEN_ATTR}]`)) hide(el, "domain");
        return;
      }
      add(el);
    });

    document.querySelectorAll("[id], [class], [aria-label], [data-ad-slot]").forEach((el) => {
      if (!isAdAttr(el) || el.closest(`[${HIDDEN_ATTR}]`)) return;
      // 極小要素は広告バッジ（例: <i class="pr">）とみなし、それを含むブロックを候補にする
      add(isTiny(el) ? labelContainer(el) : el);
    });

    document.querySelectorAll("span, div, p, small, em, b, strong, a, li, dt").forEach((el) => {
      if (el.childElementCount === 0 && LABEL_RE.test(el.textContent || "") && el.getClientRects().length) {
        add(labelContainer(el));
      }
    });

    document.querySelectorAll("a[href]").forEach((a) => {
      if (isAdUrl(a.href)) add(a.closest("div, li, section, aside, article") || a);
    });

    // サイズ条件を満たすものだけ残し、候補同士が入れ子なら外側を優先
    // （外側が広告でないと判定されれば次回スキャンで内側が候補になる）
    const list = [...set].filter(sizeOk);
    const inList = new Set(list);
    return list.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (inList.has(p)) return false;
      return true;
    });
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const hosts = new Set();
    el.querySelectorAll("a[href]").forEach((a) => {
      try { hosts.add(new URL(a.href).hostname); } catch {}
    });
    const iframes = [el, ...el.querySelectorAll("iframe")]
      .filter((f) => f.tagName === "IFRAME" && f.src)
      .map((f) => { try { return new URL(f.src).hostname; } catch { return f.src; } });
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
    const cls = typeof el.className === "string" ? el.className : "";
    // 子孫の広告マーカー。極小のもの（<i class="pr"> 等、テキストに現れないアイコン）は
    // 「バッジ」と明示すると Jev の判定精度が大きく上がる（実測 0.63 → 0.95）
    const badges = new Set();
    const markers = new Set();
    el.querySelectorAll("*").forEach((c) => {
      const t = attrText(c);
      const m = t.match(ATTR_RE) || t.match(CAMEL_RE);
      if (m && isTiny(c)) badges.add(`${m[0].replace(/^[\s_-]/, "").toUpperCase()} (sponsored/ad label icon)`);
      else if (m && markers.size < 5) markers.add(`<${c.tagName.toLowerCase()} id/class="${t.trim().slice(0, 60)}">`);
      else if (c.childElementCount === 0 && LABEL_RE.test(c.textContent || "")) badges.add(`${c.textContent.trim()} (label text)`);
    });
    return [
      `page: ${host}`,
      `element: <${el.tagName.toLowerCase()} id="${el.id}" class="${cls.slice(0, 200)}" aria-label="${el.getAttribute("aria-label") || ""}">`,
      `size: ${Math.round(r.width)}x${Math.round(r.height)}px`,
      badges.size ? `badge: ${[...badges].join(", ")}` : "",
      markers.size ? `ad-like markers inside: ${[...markers].join(", ")}` : "",
      iframes.length ? `iframe hosts: ${iframes.join(", ")}` : "",
      hosts.size ? `link hosts: ${[...hosts].slice(0, 10).join(", ")}` : "",
      `text: ${text || "(none)"}`,
    ].filter(Boolean).join("\n");
  }

  async function classify(els) {
    const items = els.map((el, i) => ({ id: String(i), text: describe(el) }));
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "classify", host, items });
    } catch (e) {
      LOG("background unavailable", e);
      return;
    }
    if (!res?.ok) {
      LOG("server error:", res?.error);
      return;
    }
    for (const { id, ad } of res.results) {
      const el = els[Number(id)];
      if (!el || typeof ad !== "number") continue;
      scores.set(el, ad);
      if (ad >= settings.threshold) {
        LOG(`hide (ad=${ad.toFixed(2)})`, el);
        hide(el, "jev");
      }
    }
  }

  async function scan() {
    if (!isActive()) return;
    const candidates = collectCandidates();
    if (!candidates.length) return;
    candidates.forEach((el) => checked.add(el));
    LOG(`judging ${candidates.length} candidates`);
    for (let i = 0; i < candidates.length; i += BATCH) {
      await classify(candidates.slice(i, i + BATCH));
    }
    schedule(); // 外側が非広告だった候補の内側を拾う
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  }

  function reapplyThreshold() {
    for (const [el, ad] of scores) {
      if (!el.isConnected) { scores.delete(el); continue; }
      const hidden = el.getAttribute(HIDDEN_ATTR) === "jev";
      if (ad >= settings.threshold && !hidden) hide(el, "jev");
      else if (ad < settings.threshold && hidden) {
        el.removeAttribute(HIDDEN_ATTR);
        el.style.removeProperty("display");
        hiddenCount--;
        report();
      }
    }
  }

  function start() {
    if (!observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    schedule();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    unhideAll();
  }

  chrome.storage.local.get(settings, (s) => {
    settings = { ...settings, ...s };
    if (isActive()) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const wasActive = isActive();
    const oldThreshold = settings.threshold;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    if (wasActive && !isActive()) stop();
    else if (!wasActive && isActive()) { start(); reapplyThreshold(); }
    else if (isActive() && settings.threshold !== oldThreshold) reapplyThreshold();
  });
})();
