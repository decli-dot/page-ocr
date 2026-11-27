(() => {
  if (globalThis.pageOcrStandardName) return;

  const gostOrigin = "https://protect.gost.ru";
  const isoOrigin = "https://www.iso.org";
  const isoData = "https://isopublicstorageprod.blob.core.windows.net/opendata/_latest/iso_deliverables_metadata/json/iso_deliverables_metadata.jsonl";
  const dinOrigin = "https://www.dinmedia.de";
  const dinSearch = { app: "MQ6K7GZA3Z", index: "prod_dinmedia_products" };

  const domestic = "(?:(?:ГОСТ|GOST)(?:\\s*[РRP](?=\\s|\\d))?(?:[\\s/]+(?:ИСО|ISO|МЭК|IEC|ЕН|EN|TS|TR))*|ПНСТ|PNST)\\s*\\d+(?:[.-]\\d+)*(?:-(?:\\d{4}|\\d{2}))";
  const foreign = "(?:(?:DIN|BS|NF)\\s+(?:(?:EN|ISO|IEC)\\s+)*|EN\\s+(?:(?:ISO|IEC)\\s+)?|ISO(?:\\s*\\/\\s*(?:IEC|TS|TR|PAS|DIS|FDIS)(?:\\s+TS)?)?\\s+)\\d+(?:-\\d+)*(?:[:\\-]\\d{4})(?:-\\d{2})?";
  const suffix = "(?:\\+\\s*(?:A\\d+|AC):\\d{4}|\\s*\\/\\s*(?:Amd\\s*\\d+|Cor\\s*\\d+):\\d{4})*";
  const referencePattern = new RegExp("(?<![\\p{L}\\p{N}])(?:" + domestic + "|" + foreign +
    ")" + suffix + "(?![\\p{L}\\p{N}]|[.:+-]\\d|\\s*/\\s*(?:Amd|Cor))", "giu");

  function clean(text) {
    return String(text ?? "").replace(/\s+/gu, " ").trim();
  }

  function referenceText(text) {
    return clean(String(text ?? "").normalize("NFKC").replace(/[‐‑‒–—−]/gu, "-"))
      .replace(/\s*([:/+-])\s*/gu, "$1");
  }

  function referenceKey(text) {
    let key = referenceText(text).toUpperCase()
      .replace(/^GOST(?=\s|[РRP]|\d)/u, "ГОСТ")
      .replace(/^PNST(?=\s|\d)/u, "ПНСТ")
      .replace(/^ГОСТ\s*[RP](?=\s|\d)/u, "ГОСТ Р");
    if (/^(?:ГОСТ|ПНСТ)/u.test(key)) {
      return key.replace(/^ГОСТР/u, "ГОСТ Р").replace(/^(ГОСТ|ПНСТ)(?=\d)/u, "$1 ");
    }
    return key.replace(/-(\d{4})(?=$|-\d{2}$|[+/])/u, ":$1")
      .replace(/\/(AMD|COR)\s*(\d+)/gu, "/$1 $2");
  }

  function references(text) {
    return Array.from(referenceText(text).matchAll(referencePattern), ([value]) => value);
  }

  function wantedReference(heading, cover) {
    if (/(?:изменение|поправка|amendment|corrigendum)\s*(?:(?:№|no\.?)\s*)?\d*\s+(?:к|to)\s/iu.test(heading)) {
      return null;
    }
    const candidates = references(heading);
    const fromTitle = new Map(candidates.map(value => [referenceKey(value), value]));
    const coverReferences = cover.slice(0, 1800).split(/\r?\n/u).slice(0, 22)
      .flatMap(line => {
        const label = line.trim().replace(/^[^\p{L}\p{N}]+/u, "")
          .replace(/^(?:IS0|150)(?=\s+\d+(?:-\d+)*\s*[:\-]\s*(?:19|20)\d{2}\b)/iu, "ISO");
        const first = references(label)[0];
        return first && referenceText(label).toUpperCase().startsWith(first.toUpperCase()) ? [first] : [];
      });
    const fromCover = new Map(coverReferences.map(value => [referenceKey(value), value]));
    if (fromCover.size > 1) {
      if (fromTitle.size !== 1) return null;
      const [id, label] = fromTitle.entries().next().value;
      return /^ISO(?:[/ ]|$)/u.test(id) && fromCover.has(id) ? label : null;
    }
    if (fromCover.size) {
      const [key, value] = fromCover.entries().next().value;
      return !fromTitle.size || fromTitle.has(key) ? value : null;
    }
    return fromTitle.size === 1 ? fromTitle.values().next().value : null;
  }

  function field(document, label) {
    const nodes = document.querySelectorAll("span, dt, th, label, p");
    for (const node of nodes) {
      if (clean(node.textContent).replace(/:$/u, "").toLowerCase() !== label) continue;
      const value = clean(node.nextElementSibling?.textContent);
      if (value && !/^[-–—]$/u.test(value)) return value;
    }
    return "";
  }

  function gostCard(document) {
    const designation = field(document, "обозначение") || clean(document.querySelector("h1")?.textContent);
    const full = field(document, "полное обозначение") || designation;
    const title = field(document, "заглавие на русском языке");
    if (!designation || !title) return null;
    return { designation, full, title };
  }

  function heading(designation, title) {
    return title ? designation + " — " + title : designation;
  }

  async function request(url, signal, options = {}) {
    const response = await fetch(url, { credentials: "omit", redirect: "error", signal, ...options });
    if (!response.ok) throw new Error("Catalogue request failed: " + response.status);
    return response;
  }

  async function html(url, signal) {
    const response = await request(url, signal);
    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  function cardURL(value, origin, pathPattern) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.username || url.password || !pathPattern.test(url.pathname)) return null;
      return origin + url.pathname;
    } catch {
      return null;
    }
  }

  async function gostTitle(wanted, signal) {
    const search = new URL("/gost", gostOrigin);
    search.search = new URLSearchParams({ year: "0", month: "0", search: wanted });
    const document = await html(search, signal);
    const key = referenceKey(wanted);
    const links = new Set(Array.from(document.querySelectorAll("a[href]"))
      .filter(link => referenceKey(link.textContent) === key)
      .map(link => cardURL(link.getAttribute("href"), gostOrigin, /^\/gost\/details\/[a-f0-9-]+$/iu))
      .filter(Boolean));
    if (links.size !== 1) return null;
    const card = gostCard(await html(links.values().next().value, signal));
    return card && referenceKey(card.designation) === key ? heading(card.full, card.title) : null;
  }

  async function searchIndex(config, key, query, signal) {
    if (!key) return [];
    const response = await request("https://" + config.app.toLowerCase() +
      "-dsn.algolia.net/1/indexes/" + config.index + "/query", signal, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Algolia-Application-Id": config.app,
        "X-Algolia-API-Key": key,
      },
      body: JSON.stringify({ query, hitsPerPage: 30, typoTolerance: false }),
    });
    const { hits } = await response.json();
    return Array.isArray(hits) ? hits : [];
  }

  function isoCardURL(value) {
    const path = /^\/(?:[a-z]{2}\/)?standard\/(\d+)\.html$|^\/cms\/[^?#]+\/sites\/isoorg\/contents\/data\/standard\/(?:\d+\/)+(\d+)\.html$/iu;
    const url = cardURL(value, isoOrigin, path);
    if (!url) return null;
    const match = new URL(url).pathname.match(path);
    return isoOrigin + "/standard/" + (match[1] || match[2]) + ".html";
  }

  function readIsoPage() {
    const links = selector => Array.from(document.querySelectorAll(selector), link => ({
      label: link.textContent,
      url: link.href,
    }));
    return {
      url: location.href,
      results: links("#search-results .card-title a[href]"),
      empty: /\b0\s*results?\s+found\b/i.test(document.querySelector("#stats-container")?.textContent || ""),
      title: document.querySelector("h1.stdTitle")?.textContent,
      labels: Array.from(document.querySelectorAll('meta[property="og:title"]'), node => node.content),
      editions: links("#lifecycle h4 a[href]"),
    };
  }

  async function waitForIsoPage(tabId, matches, signal) {
    while (!signal?.aborted) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && tab.url?.startsWith(isoOrigin + "/")) {
        const [entry] = await chrome.scripting.executeScript({ target: { tabId }, func: readIsoPage });
        if (entry?.result && matches(entry.result)) return entry.result;
      }
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    return null;
  }

  function exactEdition(links, wanted) {
    const urls = new Set(links.filter(link => referenceKey(link.label) === wanted)
      .map(link => isoCardURL(link.url)).filter(Boolean));
    return urls.size === 1 ? urls.values().next().value : null;
  }

  function isoHeading(card, wanted) {
    const title = clean(card?.title);
    const printed = title.match(new RegExp("^" + foreign + suffix + "(?=\\s|$)", "iu"))?.[0];
    const designation = [...(card?.labels || []), printed].map(clean)
      .find(value => referenceKey(value) === wanted && title.startsWith(value));
    const name = designation && title.slice(designation.length).replace(/^\s*[-—–]?\s*/u, "").trim();
    return name ? heading(designation, name) : null;
  }

  async function isoWebTitle(wanted, signal) {
    const query = wanted.split(":")[0];
    if (signal?.aborted) return null;
    const port = chrome.runtime.connect({ name: "iso-catalogue" });
    try {
      const tabId = await new Promise(resolve => {
        port.onMessage.addListener(message => resolve(message.tabId));
        port.onDisconnect.addListener(() => resolve(null));
        signal?.addEventListener("abort", () => resolve(null), { once: true });
        port.postMessage({ query });
      });
      if (!Number.isInteger(tabId) || signal?.aborted) return null;
      const search = await waitForIsoPage(tabId, page =>
        new URL(page.url).pathname === "/search.html" && (page.results.length || page.empty), signal);
      if (!search?.results.length) return null;

      const exact = exactEdition(search.results, wanted);
      const related = search.results.find(link => {
        const reference = referenceKey(link.label);
        return reference.split(":")[0] === query && !/\/(?:AMD|COR)\s*\d/u.test(reference) && isoCardURL(link.url);
      });
      const first = exact || isoCardURL(related?.url);
      if (!first) return null;

      async function readCard(url) {
        await chrome.tabs.update(tabId, { url });
        return waitForIsoPage(tabId, page => isoCardURL(page.url) === url && Boolean(page.title), signal);
      }

      const card = await readCard(first);
      if (!card) return null;
      const title = isoHeading(card, wanted);
      if (title || signal?.aborted) return title;
      const other = exactEdition(card.editions, wanted);
      return other && other !== first ? isoHeading(await readCard(other), wanted) : null;
    } finally {
      port.disconnect();
    }
  }

  async function isoDataTitle(wanted, signal) {
    const response = await request(isoData, signal);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        const lines = (pending + (value || "")).split("\n");
        pending = done ? "" : lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (referenceKey(record.reference) !== wanted || !record.publicationDate) continue;
          const title = clean(record.title?.en || record.title?.fr);
          if (title) return heading(record.reference, title);
        }
        if (done) return null;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  async function isoTitle(wanted, signal) {
    // Verified public catalogue entries are usable even when ISO cannot be reached.
    const local = await (await request(chrome.runtime.getURL("iso-cards.json"), signal)).json();
    const saved = local.find(card => referenceKey(card.reference) === wanted);
    if (saved) return heading(saved.reference, saved.title);

    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const requireMatch = async lookup => {
      const result = await lookup(wanted, controller.signal);
      if (!result) throw new Error("No matching ISO edition");
      return result;
    };
    try {
      return await Promise.any([requireMatch(isoDataTitle), requireMatch(isoWebTitle)]);
    } catch {
      return null;
    } finally {
      stop();
      signal?.removeEventListener("abort", stop);
    }
  }

  async function dinTitle(wanted, signal) {
    const home = await html(dinOrigin + "/en", signal);
    const config = home.querySelector("[data-app-id='" + dinSearch.app + "'][data-suggestion-index]");
    const id = referenceKey(wanted);
    const query = /^EN\s/u.test(id) ? "DIN " + wanted : wanted;
    const hits = await searchIndex(dinSearch, config?.getAttribute("data-api-key"), query, signal);
    const titles = new Set();
    for (const hit of hits) {
      if (hit["dokument-typ"] !== "N") continue;
      const subtitle = clean(hit.untertitel_en);
      const catalogueDesignation = clean(hit.titel_DOK || hit.titel);
      if (!subtitle) continue;
      if (referenceKey(catalogueDesignation) === id) {
        titles.add(heading(catalogueDesignation, subtitle));
      } else if (/^EN\s/u.test(id)) {
        const nationalNote = subtitle.match(/;\s*(?:German|English|French|Trilingual)\s+version\s+(.+)$/iu);
        const european = nationalNote && references(nationalNote[1])[0];
        if (european && referenceKey(european) === id) {
          titles.add(heading(european, subtitle.slice(0, nationalNote.index).trim()));
        }
      }
    }
    return titles.size === 1 ? titles.values().next().value : null;
  }

  async function resolveDoc88(original, firstPageText, signal) {
    const wanted = wantedReference(original, firstPageText);
    if (!wanted) return null;
    const id = referenceKey(wanted);
    if (/^(?:ГОСТ|ПНСТ)/u.test(id)) return gostTitle(id, signal);
    if (/^ISO(?:[/ ]|$)/u.test(id)) return isoTitle(id, signal);
    return dinTitle(id, signal);
  }

  globalThis.pageOcrStandardName = { gostCard, heading, resolveDoc88 };
})();

