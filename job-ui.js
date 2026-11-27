const jobView = (() => {
  const get = (id) => document.getElementById(id);
  const phases = ["capture", "ocr", "download"];
  const status = get("status");
  const progress = get("progress");
  const hint = get("hint");
  const cancel = get("cancel");
  const returnButton = get("return");
  const showFile = get("show-file");
  const startTime = Date.now();
  let phase = "capture";
  let text = status.textContent;
  let done = 0;
  let total = 0;
  let stopping = false;
  let finished = false;

  function updateTime() {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    get("elapsed").textContent = [Math.floor(seconds / 60), seconds % 60].map((value) =>
      String(value).padStart(2, "0")).join(":");
  }
  const clock = setInterval(updateTime, 1000);
  get("close").addEventListener("click", async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.remove(tab.id);
  });

  function stages(terminal) {
    const active = phases.indexOf(phase);
    phases.forEach((step, index) => {
      const element = get("stage-" + step);
      let state = "waiting";
      let label = "Ожидает";
      if (terminal === "complete" || index < active) {
        state = "done";
        label = step === "download" ? "Файл в загрузках" : formatPages(total);
      } else if (index === active) {
        state = terminal || "active";
        if (terminal === "error") label = "Ошибка";
        else if (terminal === "cancelled") label = "Отменено";
        else if (step === "download") label = "Сохраняю файл";
        else label = total ? done + " / " + total + " стр." : "Подключение";
      }
      element.dataset.state = state;
      if (state === "active") element.setAttribute("aria-current", "step");
      else element.removeAttribute("aria-current");
      get("stage-" + step + "-label").textContent = label;
    });
  }

  function renderStatus() {
    status.textContent = stopping ? "Останавливаю после текущей операции…" : text;
  }

  return {
    init(book, sourceTabId) {
      showDocument(book);
      total = book.total;
      get("metadata").hidden = false;
      returnButton.hidden = false;
      returnButton.addEventListener("click", async () => {
        try {
          await chrome.tabs.update(sourceTabId, { active: true });
        } catch {
          returnButton.hidden = true;
        }
      });
    },

    onCancel(callback) { cancel.addEventListener("click", callback); },

    working(step, message, pagesDone) {
      phase = step;
      text = message;
      done = pagesDone;
      get("workspace").dataset.phase = phase;
      stages();
      renderStatus();
      const counted = total && phase !== "download";
      if (counted) {
        progress.max = total;
        progress.value = done;
        progress.setAttribute("aria-label", phase === "capture" ? "Собранные страницы" : "Распознанные страницы");
      } else {
        progress.removeAttribute("value");
        progress.setAttribute("aria-label", "Сохранение PDF");
      }
      get("counter").textContent = counted ? done + " / " + total : "";
      returnButton.hidden = phase !== "capture";
      hint.textContent = {
        capture: "Оставь вкладку документа открытой, пока загружаются листы.",
        ocr: "Страницы собраны. Вкладку Doc88 можно закрыть. Распознавание идёт на этом компьютере.",
        download: "Готовый PDF сохраняется в загрузки браузера.",
      }[phase];
      hint.hidden = false;
    },

    recognition(inProgress) {
      if (finished || phase !== "ocr") return;
      progress.value = Math.min(total, done + inProgress);
    },

    stopping() {
      stopping = true;
      cancel.disabled = true;
      renderStatus();
    },

    lockDownload() { cancel.disabled = true; },

    finish(outcome, message, file) {
      finished = true;
      clearInterval(clock);
      updateTime();
      get("workspace").dataset.phase = outcome;
      stages(outcome);
      status.textContent = message;
      get("bar-area").hidden = true;
      hint.hidden = true;
      returnButton.hidden = true;
      cancel.hidden = true;
      get("close").hidden = false;
      if (file) {
        const large = file.bytes >= 1048576;
        const size = new Intl.NumberFormat("ru", { maximumFractionDigits: 1 })
          .format(file.bytes / (large ? 1048576 : 1024)) + (large ? " МБ" : " КБ");
        get("result-filename").textContent = file.name;
        const resolution = file.enhancedPages
          ? `Листы обработаны: ${file.enhancedPages} из ${total}. От ${file.minSourceLongSide} пикс. в источнике, от ${file.minOutputLongSide} пикс. в PDF.`
          : `От ${file.minOutputLongSide} пикс. по длинной стороне.`;
        const naming = file.catalogueConfirmed ? "Название по каталогу." : "Название по заголовку Doc88.";
        get("result-meta").textContent = `${formatPages(total)} · ${size} · ${resolution} ${naming}`;
        showFile.addEventListener("click", () => chrome.downloads.show(file.id));
        get("result").hidden = false;
      }
    },
  };
})();
