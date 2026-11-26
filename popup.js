const start = document.getElementById("start");
const notice = document.getElementById("notice");
const state = document.getElementById("state");
const meter = document.getElementById("popup-progress");
const card = document.getElementById("document");
let sourceTabId;
let book;

async function send(command, fields = {}) {
  const response = await chrome.runtime.sendMessage({ channel: "gost-ocr", command, tabId: sourceTabId, ...fields });
  if (!response?.ok) throw new Error(response?.error || "Расширение не получило ответ от вкладки.");
  return response;
}

function showError(error) {
  state.dataset.state = "error";
  notice.textContent = error.message;
}

async function loadCard() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Открой вкладку со стандартом.");
    sourceTabId = tab.id;
    book = await send("inspect");
    showDocument(book);
    card.hidden = false;
    if (book.running) {
      notice.textContent = book.text;
      state.dataset.state = book.phase;
      if (book.phase === "capture" || book.phase === "ocr") {
        meter.max = book.total;
        meter.value = book.done;
        meter.hidden = false;
      }
      start.textContent = "Ход выполнения";
      start.disabled = !book.progressTabId;
      return;
    }
    notice.textContent = "Оставь вкладку документа открытой до окончания загрузки листов.";
    start.disabled = false;
  } catch (error) {
    showError(error);
  }
}

start.addEventListener("click", async () => {
  if (!book || start.disabled) return;
  start.disabled = true;
  try {
    if (book.running) await send("show-progress", { progressTabId: book.progressTabId });
    else await send("start");
    window.close();
  } catch (error) {
    showError(error);
    start.disabled = false;
  }
});

void loadCard();
