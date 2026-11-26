const channel = "gost-ocr";

function viewerFiles(url) {
  if (!url) return null;
  const address = new URL(url);
  if (address.origin === "https://protect.gost.ru" && address.pathname.startsWith("/gost/details/")) {
    return ["viewer.js"];
  }
  if (["https://www.doc88.com", "https://doc88.com"].includes(address.origin) &&
      /^\/p-\d+\.html$/.test(address.pathname)) {
    return ["doc88-viewer.js", "viewer.js"];
  }
  return null;
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
  const files = viewerFiles(tab.url);
  if (!files) {
    return { ok: false, error: "Открой документ на Doc88 или вкладку «Просмотр документа» в карточке Росстандарта." };
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
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
    : message.command === "show-progress" && (fromPopup || viewerFiles(sender.url));
  if (!allowed) return;
  request(message).then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});
