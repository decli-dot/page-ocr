const pageQuality = (() => {
  const target = 3840;
  const jpegQuality = 0.86;

  function outputSize(width, height) {
    const scale = Math.min(target / Math.max(width, height), Math.sqrt(12_000_000 / (width * height)), 4);
    if (scale <= 1.05) return null;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  function canvasFor(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function sharpen({ data, width, height }) {
    const luma = new Uint8Array(width * height);
    for (let pixel = 0, channel = 0; pixel < luma.length; pixel++, channel += 4) {
      luma[pixel] = (77 * data[channel] + 150 * data[channel + 1] + 29 * data[channel + 2]) >> 8;
    }
    // A small, bounded luminance correction strengthens existing edges and leaves flat areas alone.
    for (let row = 1; row < height - 1; row++) {
      for (let pixel = row * width + 1, stop = pixel + width - 2; pixel < stop; pixel++) {
        const near = luma[pixel - 1] + luma[pixel + 1] + luma[pixel - width] + luma[pixel + width];
        const far = luma[pixel - width - 1] + luma[pixel - width + 1] +
          luma[pixel + width - 1] + luma[pixel + width + 1];
        const delta = luma[pixel] - (4 * luma[pixel] + 2 * near + far) / 16;
        if (Math.abs(delta) < 3) continue;
        const correction = Math.max(-32, Math.min(32, delta * 0.85));
        const channel = pixel * 4;
        data[channel] += correction;
        data[channel + 1] += correction;
        data[channel + 2] += correction;
      }
    }
  }

  async function enhance(bitmap, { width, height }) {
    const input = canvasFor(bitmap.width, bitmap.height);
    const output = canvasFor(width, height);
    try {
      const sourceContext = input.getContext("2d", { alpha: false, willReadFrequently: true });
      sourceContext.drawImage(bitmap, 0, 0);
      const source = sourceContext.getImageData(0, 0, input.width, input.height);
      sharpen(source);
      sourceContext.putImageData(source, 0, 0);
      const context = output.getContext("2d", { alpha: false });
      context.imageSmoothingQuality = "high";
      context.drawImage(input, 0, 0, width, height);
      const jpeg = await new Promise(resolve => output.toBlob(resolve, "image/jpeg", jpegQuality));
      if (jpeg?.type !== "image/jpeg") throw new Error("Не удалось сжать изображение страницы.");
      return jpeg.arrayBuffer();
    } finally {
      input.width = 0;
      output.width = 0;
    }
  }

  return { outputSize, enhance };
})();
