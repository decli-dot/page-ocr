const channel = "page-ocr";

function isDoc88Document(url) {
  if (!url) return false;
  const address = new URL(url);
  return ["https://www.doc88.com", "https://doc88.com"].includes(address.origin) &&
    /^\/p-\d+\.html$/.test(address.pathname);
}

function tellViewer(tabId, command, fields = {}) {
  return chrome.tabs.sendMessage(tabId, { channel, command, ...fields });
}

async function startExport(tab) {
  const job = crypto.randomUUID();
  const started = await tellViewer(tab.id, "begin", { job });
  if (!started.ok) return started;

  const progress = new URL(chrome.runtime.getURL("job.html"));
  progress.search = new URLSearchParams({ tab: String(tab.id), job });
  try {
    await chrome.tabs.create({ windowId: tab.windowId, url: progress.href, active: false });
    return { ok: true };
  } catch (error) {
    const message = "Не удалось открыть ход выполнения. " + error.message;
    await tellViewer(tab.id, "finish", { job, phase: "error", text: message }).catch(() => {});
    return { ok: false, error: message };
  }
}

async function request(message) {
  if (message.command === "show-progress") {
    if (!Number.isInteger(message.progressTabId)) throw new Error("Вкладка выполнения закрыта.");
    await chrome.tabs.update(message.progressTabId, { active: true });
    return { ok: true };
  }

  const tab = await chrome.tabs.get(message.tabId);
  if (!isDoc88Document(tab.url)) {
    return { ok: false, error: "Открой документ на Doc88 и снова нажми значок Page OCR." };
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["doc88-viewer.js", "viewer.js"],
  });
  if (message.command === "start") return startExport(tab);

  const state = await tellViewer(tab.id, "inspect");
  if (state.running && state.progressTabId) {
    const exists = await chrome.tabs.get(state.progressTabId).catch(() => null);
    if (!exists) {
      await tellViewer(tab.id, "finish", { job: state.job, phase: "cancelled", text: "Вкладка выполнения закрыта." });
      return tellViewer(tab.id, "inspect");
    }
  }
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== channel) return;
  const fromPopup = sender.url === chrome.runtime.getURL("popup.html");
  const allowed = (message.command === "inspect" || message.command === "start")
    ? fromPopup
    : message.command === "show-progress" && (fromPopup || isDoc88Document(sender.url));
  if (!allowed) return;
  request(message).then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== "iso-catalogue" || sender?.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL("job.html") + "?")) return;

  let tabId;
  let closed = false;
  let started = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    if (Number.isInteger(tabId)) void chrome.tabs.remove(tabId).catch(() => {});
  });
  port.onMessage.addListener(async ({ query } = {}) => {
    if (started || closed) return;
    started = true;
    if (typeof query !== "string" || query.length > 100 ||
        !/^ISO(?:\/(?:IEC|TS|TR|PAS|DIS|FDIS)(?: TS)?)? \d+(?:-\d+)*$/u.test(query)) {
      port.postMessage({ tabId: null });
      return;
    }
    const url = new URL("https://www.iso.org/search.html");
    url.searchParams.set("q", query);
    try {
      const tab = await chrome.tabs.create({ url: url.href, active: false, windowId: sender.tab?.windowId });
      tabId = tab.id;
      if (closed) await chrome.tabs.remove(tabId).catch(() => {});
      else port.postMessage({ tabId });
    } catch {
      if (!closed) port.postMessage({ tabId: null });
    }
  });
});
