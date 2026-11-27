(() => {
  if (globalThis.pageOcrViewerLoaded) return;
  globalThis.pageOcrViewerLoaded = true;

  const channel = "page-ocr";
  const doc88 = globalThis.decliDoc88Viewer;
  const maxPixels = 50_000_000;
  let doc88Export;
  let job;
  let panel;
  let originalScroll;

  function error(message, code) {
    return Object.assign(new Error(message), { code });
  }

  function show({ text, done = 0, total = 0, phase, heading, progressTabId }) {
    const final = ["complete", "error", "cancelled"].includes(phase);
    if (!panel) {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; }
        :host([hidden]) { display: none; }
        section { --phase: #a13e27; box-sizing: border-box; width: min(370px, calc(100vw - 36px));
          padding: 15px 17px; color: #35221d; background: #fffaf4;
          border: 1px solid #e0c9b7; border-top: 3px solid var(--phase); border-radius: 13px; box-shadow: 0 10px 30px #5023132a;
          font: 14px/1.4 system-ui, sans-serif; }
        section[data-phase='ocr'] { --phase: #815140; }
        section[data-phase='download'] { --phase: #87571e; }
        section[data-phase='error'] { --phase: #a1262e; }
        strong { display: block; color: var(--phase); font-size: 12px; letter-spacing: .045em; }
        p { margin: 6px 0 8px; overflow-wrap: anywhere; }
        .document { font-weight: 700; font-size: 15px; }
        .meter { display: flex; align-items: center; gap: 8px; color: var(--phase); font-size: 12px; }
        progress { width: 100%; height: 8px; accent-color: var(--phase); }
        .count { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        [hidden] { display: none !important; }
        button { font: inherit; font-size: 12px; color: #35221d; background: #faece0; border: 1px solid #e1c7b2;
          padding: 6px 10px; border-radius: 7px; cursor: pointer; }
        button:hover:not(:disabled) { background: #f3dcc8; }
        button:disabled { cursor: default; opacity: .55; }
        button:focus-visible { outline: 2px solid #35221d; outline-offset: 2px; }
      `;
      const box = document.createElement("section");
      const label = document.createElement("strong");
      const title = document.createElement("p");
      title.className = "document";
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      const meter = document.createElement("div");
      meter.className = "meter";
      const progress = document.createElement("progress");
      const count = document.createElement("span");
      count.className = "count";
      meter.append(progress, count);
      const actions = document.createElement("div");
      actions.className = "actions";
      const details = document.createElement("button");
      details.type = "button";
      details.textContent = "Ход выполнения";
      details.addEventListener("click", (event) => {
        if (!event.isTrusted || !panel?.progressTabId) return;
        chrome.runtime.sendMessage({ channel, command: "show-progress", progressTabId: panel.progressTabId })
          .then((response) => { if (!response?.ok) details.hidden = true; }, () => { details.hidden = true; });
      });
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        if (!job) {
          host.remove();
          panel = undefined;
          return;
        }
        job.cancelled = true;
        status.textContent = "Останавливаю после текущей операции…";
        button.disabled = true;
        chrome.runtime.sendMessage({ channel, command: "cancel", job: job.id }).catch(() => {
          job = undefined;
          show({ text: "Экспорт отменён.", phase: "cancelled" });
        });
      });
      actions.append(details, button);
      box.append(label, title, status, meter, actions);
      shadow.append(style, box);
      document.body.append(host);
      panel = { host, box, label, title, status, meter, progress, count, details, button };
    }
    panel.host.hidden = false;
    panel.box.setAttribute("data-phase", phase);
    panel.label.textContent = {
      capture: "Doc88 · Загрузка листов",
      ocr: "Doc88 · Распознавание",
      download: "Doc88 · Сохранение",
      complete: "Doc88 · PDF готов",
      error: "Doc88 · Ошибка экспорта",
      cancelled: "Doc88 · Экспорт отменён",
    }[phase];
    panel.title.textContent = heading?.split(" — ")[0] || "Page OCR · Doc88";
    panel.status.textContent = text;
    panel.meter.hidden = !total || final || phase === "download";
    panel.progress.setAttribute("aria-label", phase === "ocr" ? "Распознанные страницы" : "Собранные страницы");
    panel.progress.max = total || 1;
    panel.progress.value = done;
    panel.count.textContent = done + " / " + total;
    panel.progressTabId = progressTabId;
    panel.details.hidden = !progressTabId;
    panel.button.textContent = final ? "Закрыть" : "Отменить";
    panel.button.hidden = phase === "download";
    panel.button.disabled = Boolean(job?.cancelled);
  }

  function checkCancelled() {
    if (job?.cancelled) throw error("Сборка остановлена.", "cancelled");
  }

  function readPixels(picture) {
    const { node, width, height } = picture;
    if (width * height > maxPixels) {
      throw error("Изображение листа слишком велико для экспорта в браузере.", "page-size");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    try {
      // The image or canvas supplies the full sheet, including off-screen portions and margins.
      context.drawImage(node, 0, 0, width, height);
      const image = canvas.toDataURL("image/png");
      if (image === "data:,") throw error("Не удалось сохранить изображение листа.", "page-image");
      return image;
    } catch (exception) {
      if (exception.name === "SecurityError") {
        throw error("Браузер ограничил чтение изображения этого листа.", "page-access");
      }
      throw exception;
    }
  }

  function ancestors(element) {
    const chain = [];
    for (let node = element; node;) {
      node = node.parentElement || node.getRootNode().host;
      if (node instanceof HTMLElement) chain.push(node);
    }
    return chain;
  }

  function scrollPositions(node) {
    return ancestors(node).map((parent) => [parent, parent.scrollLeft, parent.scrollTop]);
  }

  function restoreScroll(positions) {
    for (const [node, x, y] of positions) {
      if (node.isConnected) node.scrollTo({ left: x, top: y, behavior: "instant" });
    }
  }

  async function restoreDoc88() {
    await doc88Export?.restore();
    if (!doc88.requiresUser() && originalScroll) restoreScroll(originalScroll);
  }

  function begin(message) {
    if (job) throw error("Экспорт этого документа уже идёт.", "busy");
    job = { id: message.job, ...doc88.inspect(), cancelled: false, phase: "capture", text: "Готовлю сборку PDF…", done: 0 };
    originalScroll = scrollPositions(doc88.page(job.current) || doc88.page(1));
    doc88Export = doc88.createExport({ maxPixels, readPixels });
    show(job);
    return {};
  }

  async function handle(message) {
    if (message.command === "inspect") {
      return job ? { ...job, job: job.id, running: true } : doc88.inspect();
    }
    if (message.command === "begin") return begin(message);
    if (!job || job.id !== message.job) throw error("Сеанс сборки закрыт или вкладка обновлена.", "session");
    switch (message.command) {
      case "info": return { total: job.total, current: job.current, heading: job.heading };
      case "attach":
        job.progressTabId = message.progressTabId;
        show(job);
        return {};
      case "progress":
        checkCancelled();
        Object.assign(job, { phase: message.phase, text: message.text, done: message.done });
        show(job);
        return {};
      case "page": {
        if (!Number.isSafeInteger(message.number) || message.number < 1 || message.number > job.total) {
          throw error("Номер страницы вне диапазона.", "layout");
        }
        const activeJob = job;
        const image = await doc88Export.read(message.number, () => {
          if (job !== activeJob || activeJob.cancelled) throw error("Сборка остановлена.", "cancelled");
        });
        return { image };
      }
      case "stop":
        job.cancelled = true;
        return {};
      case "restore":
        await restoreDoc88();
        return {};
      case "finish":
        const finishedJob = job;
        finishedJob.cancelled = true;
        await restoreDoc88();
        job = undefined;
        doc88Export = undefined;
        originalScroll = undefined;
        show({ ...finishedJob, phase: message.phase || "error", text: message.text, done: message.done });
        return {};
      default: throw error("Неизвестная команда расширения.", "session");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== channel || message.command === "cancel") return;
    handle(message).then(
      (result) => reply({ ok: true, ...result }),
      (exception) => reply({ ok: false, error: exception.message, code: exception.code }),
    );
    return true;
  });
})();
