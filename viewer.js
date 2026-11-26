(() => {
  if (globalThis.gostOcrViewerLoaded) return;
  globalThis.gostOcrViewerLoaded = true;

  const channel = "gost-ocr";
  const doc88 = globalThis.decliDoc88Viewer;
  const targetShortSide = 1700;
  const maxPixels = 50_000_000;
  let doc88Export;
  let job;
  let panel;
  let originalScroll;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function error(message, code) {
    return Object.assign(new Error(message), { code });
  }

  function visible(node) {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
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
        section { --phase: #60e4c8; box-sizing: border-box; width: min(370px, calc(100vw - 36px));
          padding: 15px 17px; color: #eef5ff; background: linear-gradient(145deg, #17334a, #112138 75%);
          border: 1px solid #3d526d; border-top: 3px solid var(--phase); border-radius: 13px; box-shadow: 0 10px 30px #07142150;
          font: 14px/1.4 system-ui, sans-serif; }
        section[data-phase='ocr'] { --phase: #c5b4ff; }
        section[data-phase='download'] { --phase: #ffd187; }
        section[data-phase='error'] { --phase: #ff9fad; }
        strong { display: block; color: var(--phase); font-size: 12px; letter-spacing: .045em; }
        p { margin: 6px 0 8px; overflow-wrap: anywhere; }
        .document { font-weight: 700; font-size: 15px; }
        .meter { display: flex; align-items: center; gap: 8px; color: var(--phase); font-size: 12px; }
        progress { width: 100%; height: 8px; accent-color: var(--phase); }
        .count { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        [hidden] { display: none !important; }
        button { font: inherit; font-size: 12px; color: #eef5ff; background: #1c304a; border: 1px solid #4f6a8b;
          padding: 6px 10px; border-radius: 7px; cursor: pointer; }
        button:hover:not(:disabled) { background: #274564; }
        button:disabled { cursor: default; opacity: .55; }
        button:focus-visible { outline: 2px solid #eef5ff; outline-offset: 2px; }
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
      capture: "ЗАГРУЗКА ЛИСТОВ",
      ocr: "РАСПОЗНАВАНИЕ",
      download: "СОХРАНЕНИЕ",
      complete: "PDF ГОТОВ",
      error: "ОШИБКА ЭКСПОРТА",
      cancelled: "ЭКСПОРТ ОТМЕНЁН",
    }[phase];
    panel.title.textContent = heading?.split(" — ")[0] || "Page OCR";
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

  function view() {
    const host = Array.from(document.querySelectorAll("doc-viewer")).find(visible);
    if (!host) return null;
    const root = host.shadowRoot || chrome.dom?.openOrClosedShadowRoot(host) || host;
    return { host, root };
  }

  function pageField(root) {
    const fields = Array.from(root.querySelectorAll("input")).filter(visible);
    const field = fields.find((item) => item.type === "number") ||
      fields.find((item) => /^\d+$/.test(item.value) && !item.readOnly);
    if (!field) throw error("Не нашёл поле номера страницы. Проверь, что открыт просмотр документа.", "layout");
    return field;
  }

  function bookInfo(root) {
    const field = pageField(root);
    const countText = (field.parentElement?.parentElement?.textContent || "") + " " + root.textContent;
    const total = Number(countText.match(/(?:из|\bof)\s*(\d+)/i)?.[1] || field.getAttribute("max"));
    const current = Number(field.value);
    if (!Number.isSafeInteger(total) || total < 1 || current < 1 || current > total) {
      throw error("Не удалось определить число страниц в просмотрщике.", "layout");
    }
    return { current, total };
  }

  function raster(root) {
    return Array.from(root.querySelectorAll("img, canvas"))
      .filter(visible)
      .map((node) => {
        if (node instanceof HTMLImageElement) {
          if (!node.complete) return null;
          return { node, width: node.naturalWidth, height: node.naturalHeight, marker: node.currentSrc };
        }
        return { node, width: node.width, height: node.height };
      })
      .filter((item) => item && item.width >= 120 && item.height >= 120)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  function canvasMarker(picture) {
    if (!picture || picture.marker !== undefined) return picture?.marker;
    const miniature = document.createElement("canvas");
    miniature.width = miniature.height = 24;
    try {
      const context = miniature.getContext("2d", { willReadFrequently: true });
      context.drawImage(picture.node, 0, 0, 24, 24);
      const rgba = context.getImageData(0, 0, 24, 24).data;
      let sample = 0;
      for (let index = 0; index < rgba.length; index += 4) sample = (sample * 31 + rgba[index]) | 0;
      return sample;
    } catch {
      return undefined;
    }
  }

  function notice(root) {
    const leaf = Array.from(root.querySelectorAll("span, p, div, [role='status']"))
      .find((node) => node.children.length === 0 && visible(node) && /^Ошибка загрузки|^Загрузка(?:…|\.{3}|\s|$)/i.test(node.textContent.trim()));
    return leaf ? leaf.textContent.trim() : "";
  }

  function checkCancelled() {
    if (job?.cancelled) throw error("Сборка остановлена.", "cancelled");
  }

  async function selectPage(number, restoring = false) {
    const { root } = view() || {};
    if (!root) throw error("Вкладка «Просмотр документа» закрыта.", "layout");
    const field = pageField(root);
    const before = raster(root);
    const marker = canvasMarker(before);
    const wasCurrent = Number(field.value) === number;
    let changedInput = false;
    if (!wasCurrent) {
      field.focus({ preventScroll: true });
      field.value = String(number);
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
    }

    const start = Date.now();
    let loading = false;
    let last;
    while (Date.now() - start < 14000) {
      if (!restoring) checkCancelled();
      const status = notice(root);
      if (/^Ошибка загрузки/i.test(status)) throw error(`Страница ${number}. ${status}`, "image-load");
      loading ||= Boolean(status);
      const picture = raster(root);
      if (picture && !status && Number(pageField(root).value) === number) {
        const now = canvasMarker(picture);
        if (wasCurrent || loading || before?.node !== picture.node || now !== marker) {
          if (last?.node === picture.node && last.marker === now) return picture;
          last = { node: picture.node, marker: now };
        }
      } else {
        last = undefined;
      }
      if (!wasCurrent && !loading && !changedInput && !last && Date.now() - start > 1300) {
        changedInput = true;
        field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        field.blur();
      }
      await pause(140);
    }
    throw error(`Страница ${number} не загрузилась в просмотрщике.`, "image-load");
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

  function zoomButton(root, direction) {
    const buttons = Array.from(root.querySelectorAll("button, [role='button']")).filter(visible);
    const pattern = direction > 0 ? /увелич|zoom[\s_-]*in|^\+$/i : /уменьш|zoom[\s_-]*out|^[−-]$/i;
    const described = buttons.find((button) => pattern.test([
      button.title, button.getAttribute("aria-label"), button.textContent, button.getAttribute("class"),
    ].filter(Boolean).join(" ").trim()));
    if (described) return described.disabled || described.getAttribute("aria-disabled") === "true" ? null : described;

    // Some viewer versions label the two controls only with icons around the percentage.
    const percent = Array.from(root.querySelectorAll("span, div, output")).find((node) =>
      !node.children.length && visible(node) && /^\d{1,3}\s*%$/.test(node.textContent.trim()));
    if (!percent) return null;
    const label = percent.getBoundingClientRect();
    const x = (label.left + label.right) / 2;
    const y = (label.top + label.bottom) / 2;
    const neighbor = buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { button, dy: Math.abs((box.top + box.bottom) / 2 - y), dx: ((box.left + box.right) / 2 - x) * direction };
    }).filter((item) => item.dx > 0 && item.dx < 80 && item.dy < 12).sort((a, b) => a.dx - b.dx)[0]?.button;
    return neighbor && !neighbor.disabled && neighbor.getAttribute("aria-disabled") !== "true" ? neighbor : null;
  }

  function currentPicture(root) {
    const picture = raster(root);
    if (!picture) throw error("Изображение листа исчезло из просмотрщика.", "image-load");
    return picture;
  }

  async function changeZoom(root, direction) {
    const button = zoomButton(root, direction);
    if (!button) return false;
    const before = currentPicture(root).node.getBoundingClientRect().width;
    button.click();
    const deadline = Date.now() + 800;
    do {
      await pause(85);
      const picture = raster(root);
      if (picture && !notice(root) && (picture.node.getBoundingClientRect().width - before) * direction > 1) {
        await pause(65);
        return true;
      }
    } while (Date.now() < deadline);
    return false;
  }

  function scrollPositions(node) {
    return ancestors(node).map((parent) => [parent, parent.scrollLeft, parent.scrollTop]);
  }

  function restoreScroll(positions) {
    for (const [node, x, y] of positions) {
      if (node.isConnected) node.scrollTo({ left: x, top: y, behavior: "instant" });
    }
  }

  async function pagePixels(picture) {
    const original = readPixels(picture);
    if ((picture.node.tagName !== "CANVAS" && !picture.node.srcset) || Math.min(picture.width, picture.height) >= targetShortSide) {
      return original;
    }
    const { root } = view();
    const scroll = scrollPositions(picture.node);
    let zoomSteps = 0;
    let best = original;
    try {
      while (Math.min(picture.width, picture.height) < targetShortSide && await changeZoom(root, 1)) {
        zoomSteps++;
        checkCancelled();
        const larger = currentPicture(root);
        if (larger.width * larger.height <= picture.width * picture.height) break;
        best = readPixels(larger);
        picture = larger;
      }
      return best;
    } finally {
      try {
        for (let step = 0; step < zoomSteps; step++) {
          if (!(await changeZoom(root, -1))) break;
        }
      } finally {
        restoreScroll(scroll);
      }
    }
  }

  async function restoreDoc88() {
    await doc88Export?.restore();
    if (!doc88.requiresUser() && originalScroll) restoreScroll(originalScroll);
  }

  function cardHeading() {
    const heading = document.querySelector("main h1") || document.querySelector("h1");
    const designation = heading?.textContent.replace(/\s+/g, " ").trim();
    const tabTitle = (document.title || "")
      .replace(/\s+[—–-]\s+Росстандарт\s*$/iu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!designation) return tabTitle || "ГОСТ";

    let title = "";
    if (tabTitle.startsWith(`${designation} `)) {
      title = tabTitle.slice(designation.length).trim().replace(/^[—–-]\s+/, "");
    } else if (heading.nextElementSibling?.localName === "p") {
      title = heading.nextElementSibling.textContent.replace(/\s+/g, " ").trim();
    }
    return title && title !== designation ? `${designation} — ${title}` : designation;
  }

  function inspectBook() {
    if (doc88) return doc88.inspect();
    if (Array.from(document.querySelectorAll('a[href$="/auth/login"]')).some(visible)) {
      throw error("Войди на портал Росстандарта и заново открой «Просмотр документа».", "login");
    }
    const active = view();
    if (!active) throw error("Открой «Просмотр документа» в карточке стандарта и снова нажми значок расширения.", "layout");
    return { ...bookInfo(active.root), heading: cardHeading() };
  }

  async function begin(message) {
    if (job) throw error("Экспорт этого документа уже идёт.", "busy");
    if (!doc88 && !view() && message.reopen) {
      const button = Array.from(document.querySelectorAll("button, [role='tab']")).find((node) =>
        visible(node) && node.textContent.trim() === "Просмотр документа");
      button?.click();
      const deadline = Date.now() + 7000;
      while (!view() && Date.now() < deadline) await pause(140);
    }
    job = { id: message.job, ...inspectBook(), cancelled: false, phase: "capture", text: "Готовлю сборку PDF…", done: 0 };
    if (doc88) {
      originalScroll = scrollPositions(doc88.page(job.current) || doc88.page(1));
      doc88Export = doc88.createExport({ maxPixels, readPixels });
    }
    show(job);
    return {};
  }

  async function handle(message) {
    if (message.command === "inspect") {
      return job ? { ...job, job: job.id, running: true } : inspectBook();
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
        if (doc88) {
          const activeJob = job;
          const image = await doc88Export.read(message.number, () => {
            if (job !== activeJob || activeJob.cancelled) throw error("Сборка остановлена.", "cancelled");
          });
          return { image };
        }
        const picture = await selectPage(message.number);
        return { image: await pagePixels(picture) };
      }
      case "stop":
        job.cancelled = true;
        return {};
      case "restore":
        if (doc88) {
          await restoreDoc88();
        } else if (Number.isSafeInteger(message.number) && message.number >= 1 && message.number <= job.total) {
          await selectPage(message.number, true);
        }
        return {};
      case "finish":
        const finishedJob = job;
        finishedJob.cancelled = true;
        if (doc88) await restoreDoc88();
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
