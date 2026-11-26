const channel = "gost-ocr";
const options = new URLSearchParams(location.search);
const tabId = Number(options.get("tab"));
const job = options.get("job");
const recognitionDpi = 220;
const maxRecognitionSide = 3840;
const parallelRecognitionPixelBudget = 32_000_000;
const encoder = new TextEncoder();
const recognitionTone = Uint8Array.from({ length: 256 }, (_, gray) => Math.min(255, Math.round(gray * 255 / 222)));
// Validate a WebAssembly function containing i8x16.splat before choosing the SIMD core.
const simdAvailable = globalThis.WebAssembly?.validate(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11,
]));
const recognitionCorePath = simdAvailable ? "vendor/tesseract-core-simd-lstm.wasm.js" : "vendor/tesseract-core-lstm.wasm.js";
let cancelled = false;
let downloadLocked = false;
let progressTabId;

function checkCancelled() {
  if (cancelled) throw Object.assign(new Error("Сборка остановлена."), { code: "cancelled" });
}

function cancel() {
  if (downloadLocked) return;
  cancelled = true;
  jobView.stopping();
  void viewer("stop").catch(() => {});
}

jobView.onCancel(cancel);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.tab?.id !== tabId || message?.channel !== channel || message.job !== job || message.command !== "cancel") return;
  cancel();
  reply({ ok: true });
});

async function viewer(command, fields = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { channel, job, command, ...fields });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error || "Вкладка просмотра недоступна."), { code: response?.code });
  }
  return response;
}

async function report(phase, text, done) {
  checkCancelled();
  jobView.working(phase, text, done);
  const update = viewer("progress", { phase, text, done });
  if (phase === "capture") await update;
  else update.catch(() => {});
}

function pngFromDataUrl(uri) {
  const prefix = "data:image/png;base64,";
  if (!uri?.startsWith(prefix)) throw new Error("Просмотрщик не вернул изображение страницы.");
  const binary = atob(uri.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

function documentPath(url) {
  const source = new URL(url);
  return source.origin + source.pathname;
}

async function refreshViewer(sourcePath, total) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || sourcePath !== documentPath(tab.url)) throw new Error("Вкладка с документом изменилась.");
  let changed;
  let timeout;
  const ready = new Promise((resolve, reject) => {
    changed = (id, change) => {
      if (id === tabId && change.status === "complete") resolve();
    };
    chrome.tabs.onUpdated.addListener(changed);
    timeout = setTimeout(() => reject(new Error("Портал не открыл карточку после обновления.")), 18000);
  });
  try {
    await Promise.all([chrome.tabs.reload(tabId), ready]);
  } finally {
    chrome.tabs.onUpdated.removeListener(changed);
    clearTimeout(timeout);
  }
  checkCancelled();
  const state = await chrome.tabs.get(tabId);
  if (!state.url || sourcePath !== documentPath(state.url)) throw new Error("Портал перенаправил вкладку при обновлении.");
  await chrome.scripting.executeScript({ target: { tabId }, files: ["viewer.js"] });
  await viewer("begin", { reopen: true });
  await viewer("attach", { progressTabId });
  const resumed = await viewer("info");
  if (resumed.total !== total) throw new Error("Число страниц изменилось после обновления карточки.");
}

async function readPage(number, sourcePath, total) {
  let page;
  try {
    page = await viewer("page", { number });
  } catch (error) {
    if (error.code !== "image-load") throw error;
    await report("capture", `Повторно загружаю страницу ${number} из ${total}…`, number - 1);
    await refreshViewer(sourcePath, total);
    page = await viewer("page", { number });
  }
  return pngFromDataUrl(page.image);
}

function recognitionSize(width, height, maxSide = 2500) {
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const enlargement = Math.max(1, Math.min(2.5, 2500 / longSide, 1600 / shortSide));
  const scale = Math.min(maxSide / longSide, enlargement);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function addDocumentPage(pdf, source) {
  const image = await pdf.embedPng(await source.arrayBuffer());
  const size = recognitionSize(image.width, image.height);
  const pdfWidth = size.width * 72 / recognitionDpi;
  const page = pdf.addPage([pdfWidth, pdfWidth * image.height / image.width]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  // Compress this image now so pdf-lib can release its decoded pixels before OCR starts.
  await image.embed();
  return { width: image.width, height: image.height };
}

async function recognitionImage(source) {
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement("canvas");
  try {
    const size = recognitionSize(bitmap.width, bitmap.height, maxRecognitionSide);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    // Tesseract reads raw grayscale PGM, so the recognition copy needs no PNG compression.
    const header = encoder.encode(`P5\n${size.width} ${size.height}\n255\n`);
    const input = new Uint8Array(header.length + size.width * size.height);
    input.set(header);
    for (let offset = 0, pixel = header.length; offset < rgba.length; offset += 4, pixel++) {
      const gray = (77 * rgba[offset] + 150 * rgba[offset + 1] + 29 * rgba[offset + 2]) >> 8;
      input[pixel] = recognitionTone[gray];
    }
    const pageSize = recognitionSize(bitmap.width, bitmap.height);
    const dpi = Math.round(recognitionDpi * Math.max(size.width, size.height) / Math.max(pageSize.width, pageSize.height));
    return { bytes: input.buffer, dpi };
  } finally {
    bitmap.close();
    canvas.width = 0;
  }
}

async function createRecognizer(logger) {
  const worker = await new Promise((resolve, reject) => {
    const fail = (reason) => reject(new Error(`Ошибка локального OCR. ${String(reason)}`));
    Tesseract.createWorker(["rus", "eng"], 1, {
      workerPath: chrome.runtime.getURL("vendor/worker.min.js"),
      corePath: chrome.runtime.getURL(recognitionCorePath),
      langPath: chrome.runtime.getURL("vendor/lang"),
      workerBlobURL: false,
      cacheMethod: "none",
      errorHandler: fail,
      logger,
    }).then(resolve, fail);
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "3", user_defined_dpi: String(recognitionDpi) });
    return worker;
  } catch (error) {
    await worker.terminate().catch(() => {});
    throw error;
  }
}

async function recognizePages(images, largestRecognitionArea, onProgress) {
  const processorLimit = Math.max(1, Math.floor((navigator.hardwareConcurrency || 1) / 2));
  const memoryLimit = navigator.deviceMemory >= 8
    ? Math.max(1, Math.min(8, Math.floor(parallelRecognitionPixelBudget / largestRecognitionArea)))
    : 1;
  const workerCount = Math.min(processorLimit, memoryLimit, Math.ceil(images.length / 2));
  const fractions = Array(workerCount).fill(0);
  const showFraction = () => jobView.recognition(fractions.reduce((sum, fraction) => sum + fraction, 0));
  const starters = await Promise.allSettled(fractions.map(async (_, slot) => {
    const worker = await createRecognizer(({ status, progress }) => {
      if (status !== "recognizing text" || !Number.isFinite(progress)) return;
      fractions[slot] = Math.max(0, Math.min(1, progress));
      showFraction();
    });
    return { worker, slot };
  }));
  const workers = starters.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!workers.length) throw starters[0].reason;

  const layers = Array(images.length);
  let next = 0;
  let completed = 0;
  let halted = false;

  async function showProgress() {
    const scanning = workers.length > 1 ? `Распознаю до ${workers.length} страниц одновременно…` :
      `Распознаю страницу ${completed + 1} из ${images.length}…`;
    await onProgress(completed === images.length ? "Добавляю текстовый слой в PDF…" : scanning, completed);
    showFraction();
  }

  try {
    await showProgress();
    const results = await Promise.allSettled(workers.map(async ({ worker, slot }) => {
      try {
        while (!halted && next < images.length) {
          checkCancelled();
          const index = next++;
          const { bytes, dpi } = await recognitionImage(images[index]);
          checkCancelled();
          if (halted) break;
          await worker.setParameters({ user_defined_dpi: String(dpi) });
          const { data } = await worker.recognize(bytes, { pdfTextOnly: true }, { pdf: true, text: false });
          checkCancelled();
          if (halted) break;
          layers[index] = data.pdf;
          images[index] = null;
          fractions[slot] = 0;
          completed++;
          await showProgress();
        }
      } catch (error) {
        halted = true;
        throw error;
      }
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return layers;
  } finally {
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
  }
}

async function addSearchableLayer(pdf, page, bytes) {
  const [layer] = await pdf.embedPdf(bytes, [0]);
  page.drawPage(layer, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
}

function pdfFilename(heading) {
  const extension = ".pdf";
  const title = heading.normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/^[. ]+/, "");
  const windows = globalThis.navigator?.platform?.startsWith("Win");
  let remaining = 255 - extension.length;
  let name = "";
  for (const character of title) {
    remaining -= windows ? character.length : encoder.encode(character).length;
    if (remaining < 0) break;
    name += character;
  }
  name = name.replace(/[. ]+$/, "");
  return (name || "ГОСТ") + extension;
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = (state, reason) => {
      if (state !== "complete" && state !== "interrupted") return;
      chrome.downloads.onChanged.removeListener(changed);
      if (state === "complete") resolve();
      else reject(new Error(reason ? `Загрузка PDF прервана. ${reason}` : "Загрузка PDF прервана."));
    };
    const changed = (delta) => {
      if (delta.id === id) finish(delta.state?.current, delta.error?.current);
    };
    chrome.downloads.onChanged.addListener(changed);
    chrome.downloads.search({ id }).then(([item]) => finish(item?.state, item?.error), (failure) => {
      chrome.downloads.onChanged.removeListener(changed);
      reject(failure);
    });
  });
}

async function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    await waitForDownload(id);
    const [item] = await chrome.downloads.search({ id }).catch(() => []);
    return { id, name: item?.filename?.split(/[\\/]/).pop() || filename, bytes: item?.fileSize > 0 ? item.fileSize : bytes.length };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function run() {
  let book;
  let done = 0;
  let message;
  let outcome;
  let file;
  let restoring;
  try {
    if (!Number.isInteger(tabId) || tabId < 1 || !job) throw new Error("Запусти сборку с помощью значка расширения на вкладке документа.");
    const sourcePath = documentPath((await chrome.tabs.get(tabId)).url);
    book = await viewer("info");
    progressTabId = (await chrome.tabs.getCurrent())?.id;
    jobView.init(book, tabId);
    await viewer("attach", { progressTabId });
    const pdf = await PDFLib.PDFDocument.create();
    pdf.setTitle(book.heading);
    pdf.setSubject("Страницы документа с поисковым слоем OCR");
    pdf.setCreator("Page OCR");
    const images = [];
    let minLongSide = Infinity;
    let largestRecognitionArea = 1;
    for (let number = 1; number <= book.total; number++) {
      await report("capture", `Извлекаю страницу ${number} из ${book.total}…`, done);
      const image = await readPage(number, sourcePath, book.total);
      const { width, height } = await addDocumentPage(pdf, image);
      minLongSide = Math.min(minLongSide, Math.max(width, height));
      const recognition = recognitionSize(width, height, maxRecognitionSide);
      largestRecognitionArea = Math.max(largestRecognitionArea, recognition.width * recognition.height);
      images.push(image);
      done = number;
    }
    restoring = viewer("restore", { number: book.current }).catch(() => {});
    done = 0;

    await report("ocr", "Загружаю модели распознавания…", done);
    const layers = await recognizePages(images, largestRecognitionArea, (text, count) => {
      done = count;
      return report("ocr", text, done);
    });
    for (let index = 0; index < layers.length; index++) {
      checkCancelled();
      await addSearchableLayer(pdf, pdf.getPage(index), layers[index]);
      layers[index] = null;
    }
    await report("download", "Сохраняю готовый PDF с OCR…", done);
    const bytes = await pdf.save();
    checkCancelled();
    downloadLocked = true;
    jobView.lockDownload();
    file = { ...await download(bytes, pdfFilename(book.heading)), minLongSide };
    outcome = "complete";
    message = "PDF с поиском по тексту сохранён.";
  } catch (error) {
    const stopped = cancelled || error?.code === "cancelled";
    outcome = stopped ? "cancelled" : "error";
    message = stopped ? "Экспорт отменён." : `Экспорт остановлен. ${error?.message || String(error)}`;
  } finally {
    jobView.finish(outcome, message, file);
    if (book) await (restoring || viewer("restore", { number: book.current }).catch(() => {}));
    await viewer("finish", { phase: outcome, text: message, done }).catch(() => {});
  }
}

void run();
