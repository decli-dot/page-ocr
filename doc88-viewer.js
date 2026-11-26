(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const page = (number) => document.getElementById("page_" + number);

  function requiresUser() {
    return ["captcha_reading", "continue_page", "continueButton"].some((id) => {
      const node = document.getElementById(id);
      return node?.getClientRects().length && getComputedStyle(node).visibility === "visible";
    });
  }

  function checkAccess() {
    if (requiresUser()) {
      throw new Error("Doc88 просит подтвердить чтение. Сделай это на сайте и запусти экспорт снова.");
    }
  }

  function inspect() {
    checkAccess();
    const field = document.getElementById("pageNumInput");
    if (!field || !page(1)) {
      throw new Error("Открой документ в просмотрщике Doc88 и дождись первого листа.");
    }
    const counter = field.parentElement?.innerText.trim() || "";
    const total = Number(counter.match(/(?:\/|\bof\b|из)\s*(\d+)/i)?.[1] ||
      (/^\d+$/.test(counter) ? counter : field.getAttribute("max")));
    if (!Number.isSafeInteger(total) || total < 1 || total > 500) {
      throw new Error("Не удалось определить число страниц Doc88 или в документе больше 500 страниц.");
    }
    const current = Number(field.value);
    const heading = document.querySelector("h1")?.title ||
      document.querySelector('meta[property="og:title"]')?.content || document.title;
    return {
      total,
      current: Number.isInteger(current) && current >= 1 && current <= total ? current : 1,
      heading: heading.trim() || "Документ Doc88",
    };
  }

  function picture(number) {
    checkAccess();
    const node = page(number);
    if (!(node instanceof HTMLCanvasElement) || node.getAttribute("lz") !== "1" ||
      !node.width || !node.height || !node.getClientRects().length) return null;
    return { node, width: node.width, height: node.height };
  }

  async function select(number, checkCancelled) {
    checkAccess();
    const node = page(number);
    if (!node) throw new Error("В просмотрщике Doc88 нет страницы " + number + ".");
    checkCancelled();
    const loaded = picture(number);
    if (loaded) return loaded;
    node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const deadline = Date.now() + 20000;
    do {
      checkCancelled();
      const result = picture(number);
      if (result) return result;
      await wait(120);
    } while (Date.now() < deadline);
    throw new Error("Doc88 не показал страницу " + number + ". Проверь её во вкладке документа.");
  }


  function zoomControl(direction) {
    const pattern = direction > 0
      ? /放大|увелич|zoom[\s_-]*(?:in|plus|add)|scale[\s_-]*up/i
      : /缩小|уменьш|zoom[\s_-]*(?:out|minus|sub)|scale[\s_-]*down/i;
    const candidates = document.querySelectorAll(
      "button, a, [role='button'], [title], [aria-label], [data-title], [data-original-title], [id*='zoom' i], [class*='zoom' i]",
    );
    return Array.from(candidates).find((node) => {
      if (!(node instanceof HTMLElement) || !node.getClientRects().length ||
        getComputedStyle(node).visibility !== "visible") return false;
      const descriptions = [
        node.id, node.getAttribute("class"), node.title, node.getAttribute("aria-label"),
        node.getAttribute("data-title"), node.getAttribute("data-original-title"), node.textContent.trim(),
      ];
      return descriptions.some((description) => pattern.test(description || ""));
    });
  }

  function enabled(control) {
    return control && !control.closest(":disabled, [aria-disabled='true'], .disabled");
  }

  function betterImage(next, previous) {
    return next && next.width > previous.width && next.height > previous.height &&
      Math.abs((next.width / next.height) / (previous.width / previous.height) - 1) < 0.01;
  }

  const targetLongSide = 3840;
  const maxZoomSteps = 16;

  function createExport({ maxPixels, readPixels }) {
    let triedZoom = false;
    let zoomSteps = 0;
    let probing;
    let originalSizes;

    async function restoreTo(steps) {
      while (zoomSteps > steps && !requiresUser()) {
        const button = zoomControl(-1);
        if (!enabled(button)) break;
        button.click();
        zoomSteps--;
        await wait(100);
      }
    }

    async function enlarge(number, previous, button) {
      const displayWidth = previous.node.getBoundingClientRect().width;
      button.click();
      const deadline = Date.now() + 2200;
      let moved = false;
      let scrolled = false;
      let candidate;
      do {
        const node = page(number);
        const display = node?.getBoundingClientRect().width || 0;
        if (!moved && node && (Math.abs(display - displayWidth) >= 1 ||
          node.width !== previous.width || node.height !== previous.height)) {
          zoomSteps++;
          moved = true;
        }
        checkAccess();
        if (node && !scrolled && node.getAttribute("lz") !== "1") {
          node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          scrolled = true;
        }
        const rendered = picture(number);
        if (betterImage(rendered, previous)) {
          if (candidate?.node === rendered.node && candidate.width === rendered.width &&
              candidate.height === rendered.height) return rendered;
          candidate = rendered;
        } else {
          candidate = undefined;
        }
        await wait(80);
      } while (Date.now() < deadline);
      return null;
    }

    async function chooseDetail(number, initial, checkCancelled) {
      let image = readPixels(initial);
      let best = initial;
      let keptSteps = 0;
      originalSizes = new Map(Array.from(document.querySelectorAll("canvas[id^='page_'][lz='1']"),
        (canvas) => [canvas.id, { width: canvas.width, height: canvas.height }]));
      initial.node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      try {
        for (let attempt = 0; attempt < maxZoomSteps && Math.max(best.width, best.height) < targetLongSide; attempt++) {
          checkCancelled();
          const button = zoomControl(1);
          const undo = zoomControl(-1);
          if (!enabled(button) || !undo || button === undo) break;
          const larger = await enlarge(number, best, button);
          checkCancelled();
          if (!larger || larger.width * larger.height > maxPixels) break;
          image = readPixels(larger);
          best = larger;
          keptSteps = zoomSteps;
        }
      } finally {
        await restoreTo(keptSteps);
      }
      return image;
    }

    async function atCurrentZoom(number, initial, checkCancelled) {
      if (!zoomSteps) return initial;
      const before = originalSizes.get(initial.node.id);
      if (!before || initial.width !== before.width || initial.height !== before.height) return initial;

      // A page already rendered at the user’s zoom can keep its old canvas until it is shown.
      initial.node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const deadline = Date.now() + 2200;
      do {
        checkCancelled();
        const rendered = picture(number);
        if (betterImage(rendered, before)) return rendered;
        await wait(80);
      } while (Date.now() < deadline);
      return select(number, checkCancelled);
    }

    return {
      async read(number, checkCancelled) {
        const original = await select(number, checkCancelled);
        checkCancelled();
        if (triedZoom) {
          const rendered = await atCurrentZoom(number, original, checkCancelled);
          if (!zoomSteps || rendered.width * rendered.height <= maxPixels) return readPixels(rendered);
          await restoreTo(0);
          return readPixels(await select(number, checkCancelled));
        }
        if (Math.max(original.width, original.height) >= targetLongSide) return readPixels(original);
        triedZoom = true;
        const increase = zoomControl(1);
        const decrease = zoomControl(-1);
        if (!enabled(increase) || !decrease || increase === decrease) return readPixels(original);
        probing = chooseDetail(number, original, checkCancelled);
        return probing;
      },
      async restore() {
        await probing?.catch(() => {});
        await restoreTo(0);
      },
    };
  }

  globalThis.decliDoc88Viewer = { inspect, page, requiresUser, createExport };
})();

