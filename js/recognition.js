const DEFAULT_TEMPLATE_URL = new URL('../assets/piece-templates.json', import.meta.url);
const BOARD_SIZE = 8;
let cachedTemplates;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function makeCanvas(width, height) {
  let canvas;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    throw new Error('recognizeBoard requires a browser canvas implementation.');
  }
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function sourceDimensions(source) {
  const width = source && (source.naturalWidth || source.width);
  const height = source && (source.naturalHeight || source.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('The source must be a loaded image, canvas, or ImageBitmap.');
  }
  return { width, height };
}

async function getTemplates(options) {
  if (options.templates) return options.templates;
  if (!cachedTemplates) {
    cachedTemplates = fetch(options.templateUrl || DEFAULT_TEMPLATE_URL)
      .then(response => {
        if (!response.ok) throw new Error(`Unable to load piece templates (${response.status}).`);
        return response.json();
      })
      .catch(error => {
        cachedTemplates = undefined;
        throw error;
      });
  }
  return cachedTemplates;
}

function decodeTemplates(data) {
  const size = Number(data.size);
  const offset = Number(data.offset);
  if (!Number.isInteger(size) || size < 16 || !data.templates) {
    throw new TypeError('Invalid piece template data.');
  }
  const decoded = [];
  for (const piece of Object.keys(data.templates)) {
    if (!/^[pnbrqkPNBRQK]$/.test(piece)) continue;
    const binary = atob(data.templates[piece]);
    if (binary.length !== size * size) throw new TypeError('Invalid piece template length.');
    const values = new Float32Array(size * size);
    let power = 0;
    for (let i = 0; i < binary.length; i++) {
      values[i] = binary.charCodeAt(i) - offset;
      power += values[i] * values[i];
    }
    decoded.push({ piece, values, power: power / values.length });
  }
  if (!decoded.length) throw new TypeError('No usable piece templates were found.');
  return { size, offset, templates: decoded };
}

function pixelLuma(image, x, y) {
  x = clamp(Math.round(x), 0, image.width - 1);
  y = clamp(Math.round(y), 0, image.height - 1);
  const index = (y * image.width + x) * 4;
  const data = image.data;
  return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
}

function checkerScore(image, x, y, size, detailed = false) {
  const light = [];
  const dark = [];
  const cell = size / BOARD_SIZE;
  const fractions = detailed ? [0.1, 0.9] : [0.15];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const target = (row + col) % 2 === 0 ? light : dark;
      for (const fy of fractions) {
        for (const fx of fractions) {
          target.push(pixelLuma(image, x + (col + fx) * cell, y + (row + fy) * cell));
        }
      }
    }
  }
  const lightMedian = median(light.slice());
  const darkMedian = median(dark.slice());
  const contrast = Math.abs(lightMedian - darkMedian);
  if (contrast < 3) return -contrast;
  let within = 0;
  for (const value of light) within += Math.min(Math.abs(value - lightMedian), contrast);
  for (const value of dark) within += Math.min(Math.abs(value - darkMedian), contrast);
  within /= light.length + dark.length;
  return contrast - within * 2.2;
}

function borderScore(image, x, y, size) {
  const samples = 96;
  let score = 0;
  let edges = 0;
  const horizontal = (lineA, lineB) => {
    for (let i = 0; i < samples; i++) {
      const px = x + (i + 0.5) * size / samples;
      score += Math.abs(pixelLuma(image, px, lineA) - pixelLuma(image, px, lineB));
    }
    edges++;
  };
  const vertical = (lineA, lineB) => {
    for (let i = 0; i < samples; i++) {
      const py = y + (i + 0.5) * size / samples;
      score += Math.abs(pixelLuma(image, lineA, py) - pixelLuma(image, lineB, py));
    }
    edges++;
  };
  if (y > 0) horizontal(y - 1, y);
  if (y + size < image.height) horizontal(y + size - 1, y + size);
  if (x > 0) vertical(x - 1, x);
  if (x + size < image.width) vertical(x + size - 1, x + size);
  return edges ? score / (samples * edges) : 0;
}

function locationScore(image, x, y, size) {
  return checkerScore(image, x, y, size, true) + borderScore(image, x, y, size) * 0.6;
}

function contentScore(image, candidate) {
  const contrasts = [];
  const cell = candidate.size / BOARD_SIZE;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const corner = pixelLuma(image, candidate.x + (col + 0.12) * cell, candidate.y + (row + 0.12) * cell);
      const center = pixelLuma(image, candidate.x + (col + 0.5) * cell, candidate.y + (row + 0.5) * cell);
      contrasts.push(Math.abs(center - corner));
    }
  }
  contrasts.sort((a, b) => b - a);
  return contrasts.slice(0, 24).reduce((sum, value) => sum + value, 0) / 24;
}

function findGridCandidates(image) {
  const isLight = (x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const luma = pixelLuma(image, x, y);
    return luma >= 42 && luma <= 78;
  };
  const candidates = new Map();
  const add = (x, y, size) => {
    x = Math.round(x);
    y = Math.round(y);
    size = Math.round(size);
    if (size < 32 || x < 0 || y < 0 || x + size > image.width || y + size > image.height) return;
    const score = checkerScore(image, x, y, size);
    if (score < 4) return;
    const candidate = { x, y, size, score };
    candidate.score += contentScore(image, candidate) * 0.5;
    const key = `${Math.round(x / 2)},${Math.round(y / 2)},${Math.round(size / 2)}`;
    if (!candidates.has(key) || candidates.get(key).score < candidate.score) candidates.set(key, candidate);
  };
  for (let y = 0; y < image.height; y += 2) {
    const runs = [];
    let start = -1;
    for (let x = 0; x <= image.width; x++) {
      const light = x < image.width && isLight(x, y);
      if (light && start < 0) start = x;
      if (!light && start >= 0) {
        if (x - start >= 4) runs.push({ start, end: x - 1 });
        start = -1;
      }
    }
    for (const run of runs) {
      const center = Math.round((run.start + run.end) / 2);
      let top = y;
      let bottom = y;
      while (top > 0 && isLight(center, top - 1)) top--;
      while (bottom + 1 < image.height && isLight(center, bottom + 1)) bottom++;
      run.top = top;
      run.height = bottom - top + 1;
      run.width = run.end - run.start + 1;
    }
    for (let i = 0; i + 3 < runs.length; i++) {
      const group = runs.slice(i, i + 4);
      const width = (group[3].end - group[0].start + 1) / 7;
      if (width < 4 || group.some(run => Math.abs(run.width - width) > width * 0.35 || Math.abs(run.height - width) > width * 0.5)) continue;
      if (!group.every((run, index) => index === 0 || Math.abs(run.start - group[index - 1].start - width * 2) < width * 0.5)) continue;
      const top = median(group.map(run => run.top));
      const height = median(group.map(run => run.height));
      const size = 4 * (width + height);
      for (const firstCol of [0, 1]) {
        const x = group[0].start - firstCol * width;
        for (let row = firstCol; row < 8; row += 2) add(x, top - row * height, size);
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 32);
}

function findBoardCandidates(image) {
  const maxSize = Math.min(image.width, image.height);
  const minSize = Math.min(32, maxSize);
  const sizes = [];
  for (let size = minSize; size < maxSize; size *= 1.04) {
    const rounded = Math.round(size);
    if (sizes[sizes.length - 1] !== rounded) sizes.push(rounded);
  }
  if (sizes[sizes.length - 1] !== maxSize) sizes.push(maxSize);
  const candidates = [];
  for (const size of sizes) {
    const step = Math.max(1, Math.round(size / 24));
    const maxX = image.width - size;
    const maxY = image.height - size;
    const bestAtSize = [];
    const consider = (x, y) => {
      const score = checkerScore(image, x, y, size);
      if (score < 4 || (bestAtSize.length === 24 && score <= bestAtSize[23].score)) return;
      let index = 0;
      while (index < bestAtSize.length && bestAtSize[index].score >= score) index++;
      bestAtSize.splice(index, 0, { x, y, size, score });
      if (bestAtSize.length > 24) bestAtSize.pop();
    };
    for (let y = 0; y <= maxY; y += step) {
      for (let x = 0; x <= maxX; x += step) consider(x, y);
    }
    if (maxX % step !== 0 || maxY % step !== 0) {
      for (let y = 0; y <= maxY; y += step) consider(maxX, y);
      for (let x = 0; x <= maxX; x += step) consider(x, maxY);
      consider(maxX, maxY);
    }
    candidates.push(...bestAtSize);
  }
  for (const candidate of candidates) candidate.score += contentScore(image, candidate) * 0.5;
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 32);
}

function refineBoard(image, candidate) {
  const origin = { x: candidate.x, y: candidate.y, size: candidate.size };
  const valid = (x, y, size) => size >= 16 && x >= 0 && y >= 0 &&
    x + size <= image.width && y + size <= image.height &&
    Math.abs(x - origin.x) <= origin.size * 0.12 &&
    Math.abs(y - origin.y) <= origin.size * 0.12 &&
    Math.abs(size - origin.size) <= origin.size * 0.12;
  let x = Math.round(candidate.x);
  let y = Math.round(candidate.y);
  let size = Math.round(candidate.size);
  let score = valid(x, y, size) ? locationScore(image, x, y, size) : -Infinity;
  let step = Math.max(1, Math.round(size * 0.08));
  while (true) {
    for (const axis of ['size', 'x', 'y']) {
      let best = { x, y, size, score };
      let bestSizeScore = axis === 'size' ? checkerScore(image, x, y, size, true) : 0;
      for (const direction of [-1, 1]) {
        let nextX = x;
        let nextY = y;
        let nextSize = size;
        if (axis === 'size') {
          nextSize = size + direction * step;
          nextX = Math.round(x + (size - nextSize) / 2);
          nextY = Math.round(y + (size - nextSize) / 2);
        } else if (axis === 'x') {
          nextX = x + direction * step;
        } else {
          nextY = y + direction * step;
        }
        if (!valid(nextX, nextY, nextSize)) continue;
        const nextScore = locationScore(image, nextX, nextY, nextSize);
        if (axis === 'size') {
          const nextSizeScore = checkerScore(image, nextX, nextY, nextSize, true);
          if (nextSizeScore > bestSizeScore) {
            best = { x: nextX, y: nextY, size: nextSize, score: nextScore };
            bestSizeScore = nextSizeScore;
          }
        } else if (nextScore > best.score) {
          best = { x: nextX, y: nextY, size: nextSize, score: nextScore };
        }
      }
      ({ x, y, size, score } = best);
    }
    if (step === 1) break;
    step = Math.max(1, Math.floor(step / 2));
  }
  return { board: { x, y, size }, confidence: clamp((score - 4) / 14), score };
}

function normalizeBoard(sourceCanvas, board, size) {
  const canvas = makeCanvas(size * BOARD_SIZE, size * BOARD_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    sourceCanvas,
    board.x, board.y, board.size, board.size,
    0, 0, canvas.width, canvas.height
  );
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function cellFeatures(image, row, col, size, offset) {
  const values = new Float32Array(size * size);
  const corners = [];
  const border = Math.max(1, Math.round(size * 0.075));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sourceX = col * size + x;
      const sourceY = row * size + y;
      const index = (sourceY * image.width + sourceX) * 4;
      const data = image.data;
      const luma = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
      values[y * size + x] = luma;
      if ((x < border || x >= size - border) && (y < border || y >= size - border)) {
        corners.push(luma);
      }
    }
  }
  const background = median(corners);
  let energy = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] = clamp(values[i] - background, -offset, 255 - offset);
    energy += Math.abs(values[i]);
  }
  return { values, energy: energy / values.length };
}

const MIN_PIECE_CORRELATION = 0.8;
const MAX_NORMALIZED_PIECE_ERROR = 0.5;
const MIN_PIECE_AMPLITUDE = 0.45;
const MAX_PIECE_AMPLITUDE = 2.4;

function recognizeCells(image, templateData) {
  const { size, offset, templates } = templateData;
  const squares = [];
  const cellResults = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cell = cellFeatures(image, row, col, size, offset);
      let cellPower = 0;
      for (let i = 0; i < cell.values.length; i++) cellPower += cell.values[i] * cell.values[i];
      cellPower /= cell.values.length;
      const scores = templates.map(template => {
        let error = 0;
        let dotProduct = 0;
        const templatePower = template.power;
        for (let i = 0; i < cell.values.length; i++) {
          const difference = cell.values[i] - template.values[i];
          error += difference * difference;
          dotProduct += cell.values[i] * template.values[i];
        }
        const mse = error / cell.values.length;
        const correlation = cellPower > 0 && templatePower > 0
          ? dotProduct / cell.values.length / Math.sqrt(cellPower * templatePower)
          : 0;
        return {
          piece: template.piece,
          mse,
          correlation,
          normalizedMse: mse / templatePower,
          amplitude: Math.sqrt(cellPower / templatePower)
        };
      }).sort((a, b) => a.mse - b.mse);

      if (cell.energy < 7) {
        squares.push(null);
        const confidence = clamp((7 - cell.energy) / 4, 0.01, 1);
        const result = { piece: null, confidence };
        if (cell.energy > 3.5) {
          result.alternatives = [{
            piece: scores[0].piece,
            confidence: Math.exp(-scores[0].mse / 1800) * 0.5
          }];
        }
        cellResults.push(result);
        continue;
      }

      const best = scores[0];
      const reliable = best.correlation >= MIN_PIECE_CORRELATION &&
        best.normalizedMse <= MAX_NORMALIZED_PIECE_ERROR &&
        best.amplitude >= MIN_PIECE_AMPLITUDE &&
        best.amplitude <= MAX_PIECE_AMPLITUDE;
      if (!reliable) {
        const correlationRejection = clamp((MIN_PIECE_CORRELATION - best.correlation) / 0.35);
        const errorRejection = clamp((best.normalizedMse - MAX_NORMALIZED_PIECE_ERROR) / 0.75);
        const amplitudeRejection = best.amplitude < MIN_PIECE_AMPLITUDE
          ? clamp((MIN_PIECE_AMPLITUDE - best.amplitude) / 0.3)
          : clamp((best.amplitude - MAX_PIECE_AMPLITUDE) / 1.5);
        const rejection = Math.max(correlationRejection, errorRejection, amplitudeRejection);
        squares.push(null);
        cellResults.push({
          piece: null,
          confidence: clamp(0.25 + rejection * 0.75),
          alternatives: scores.slice(0, 3).map(score => ({
            piece: score.piece,
            confidence: Math.exp(-score.mse / 1800) * 0.5
          }))
        });
        continue;
      }

      const separation = clamp((scores[1].mse - best.mse) / Math.max(scores[1].mse, 1));
      const fit = Math.exp(-best.mse / 1800);
      const confidence = clamp(fit * (0.7 + separation * 0.3));
      squares.push(best.piece);
      cellResults.push({
        piece: best.piece,
        confidence,
        alternatives: scores.slice(1, 3).map(score => ({
          piece: score.piece,
          confidence: Math.exp(-score.mse / 1800) * 0.5
        }))
      });
    }
  }
  return { squares, cellResults };
}

function detectOrientation(squares) {
  let whiteEvidence = 0;
  let blackEvidence = 0;
  for (let index = 0; index < squares.length; index++) {
    const piece = squares[index];
    if (!piece) continue;
    const row = Math.floor(index / BOARD_SIZE);
    const isWhite = piece === piece.toUpperCase();
    if (row >= 6) {
      if (isWhite) whiteEvidence++;
      else blackEvidence++;
    } else if (row < 2) {
      if (isWhite) blackEvidence++;
      else whiteEvidence++;
    }
  }
  return whiteEvidence >= blackEvidence ? 'white' : 'black';
}

export async function recognizeBoard(source, options = {}) {
  const dimensions = sourceDimensions(source);
  const templatePromise = getTemplates(options);
  const sourceCanvas = makeCanvas(dimensions.width, dimensions.height);
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(source, 0, 0);
  const sourceImage = sourceContext.getImageData(0, 0, dimensions.width, dimensions.height);
  const templateData = decodeTemplates(await templatePromise);
  const evaluationCache = new Map();
  const evaluateLocation = location => {
    const { x, y, size } = location.board;
    const key = `${x},${y},${size}`;
    if (evaluationCache.has(key)) return evaluationCache.get(key);
    const normalized = normalizeBoard(sourceCanvas, location.board, templateData.size);
    const recognized = recognizeCells(normalized, templateData);
    const pieceEvidence = recognized.cellResults.reduce((sum, cell, index) =>
      recognized.squares[index] ? sum + cell.confidence : sum, 0
    );
    const entry = {
      ...recognized,
      location,
      pieceEvidence,
      rank: pieceEvidence * 20 + location.confidence
    };
    evaluationCache.set(key, entry);
    return entry;
  };
  let locations = [];

  if (options.board) {
    const { x, y, size } = options.board;
    if (![x, y, size].every(Number.isFinite) || size <= 0 || x < 0 || y < 0 ||
        x + size > dimensions.width || y + size > dimensions.height) {
      throw new RangeError('options.board must describe a square inside the source image.');
    }
    locations = [{ board: { x, y, size }, confidence: 1 }];
  } else {
    const scanScale = Math.min(1, 640 / Math.max(dimensions.width, dimensions.height));
    const scanCanvas = makeCanvas(
      Math.max(1, Math.round(dimensions.width * scanScale)),
      Math.max(1, Math.round(dimensions.height * scanScale))
    );
    const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
    scanContext.imageSmoothingEnabled = true;
    scanContext.imageSmoothingQuality = 'high';
    scanContext.drawImage(sourceCanvas, 0, 0, scanCanvas.width, scanCanvas.height);
    const scanImage = scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const keys = new Set();
    const addLocation = location => {
      const key = `${location.board.x},${location.board.y},${location.board.size}`;
      if (!keys.has(key)) {
        keys.add(key);
        locations.push(location);
      }
    };
    const toOriginalLocation = candidate => {
      const size = Math.min(candidate.size / scanScale, dimensions.width, dimensions.height);
      const x = clamp(candidate.x / scanScale, 0, dimensions.width - size);
      const y = clamp(candidate.y / scanScale, 0, dimensions.height - size);
      const board = { x: Math.round(x), y: Math.round(y), size: Math.round(size) };
      const score = checkerScore(sourceImage, board.x, board.y, board.size, true);
      return { board, confidence: clamp((score - 4) / 14), score };
    };

    const fastSize = Math.min(scanImage.width, scanImage.height);
    const fastStep = Math.max(1, Math.round(fastSize / 100));
    const fastCandidates = [];
    for (let y = 0; y <= scanImage.height - fastSize; y += fastStep) {
      for (let x = 0; x <= scanImage.width - fastSize; x += fastStep) {
        const candidate = { x, y, size: fastSize };
        const score = checkerScore(scanImage, x, y, fastSize);
        if (score >= 4) fastCandidates.push({ ...candidate, score: score + contentScore(scanImage, candidate) * 0.5 });
      }
    }
    fastCandidates.sort((a, b) => b.score - a.score);
    let fastBest;
    for (const candidate of fastCandidates.slice(0, 32)) {
      const entry = evaluateLocation(toOriginalLocation(candidate));
      if (!fastBest || entry.rank > fastBest.rank) fastBest = entry;
    }
    if (fastBest && fastBest.squares.filter(Boolean).length >= 28 && fastBest.pieceEvidence > 15) {
      locations = [fastBest.location];
    } else {
      const gridCandidates = findGridCandidates(scanImage);
      const candidates = gridCandidates.length >= 4 ? gridCandidates : findBoardCandidates(scanImage);
      for (const candidate of candidates) addLocation(toOriginalLocation(candidate));
      if (!locations.length) {
        locations = [refineBoard(sourceImage, {
          x: 0,
          y: 0,
          size: Math.min(dimensions.width, dimensions.height)
        })];
      }
    }
  }

  let best;
  const evaluated = [];
  for (const location of locations) {
    const entry = evaluateLocation(location);
    evaluated.push(entry);
    if (!best || entry.rank > best.rank) best = entry;
  }

  if (!options.board && best.squares.filter(Boolean).length < 28) {
    const promising = evaluated.filter(entry => entry.pieceEvidence > 0.05)
      .sort((a, b) => b.pieceEvidence - a.pieceEvidence)
      .slice(0, 3);
    const unit = Math.max(1, Math.max(dimensions.width, dimensions.height) / 640);
    refineCandidates: for (const entry of promising) {
      const origin = entry.location.board;
      for (const sizeStep of [-5, -4, -3, -2.5, -2, -1, 0, 1, 2, 2.5, 3, 4, 5]) {
        for (const yStep of [-4, -2, -1, 0, 1, 2, 4]) {
          const size = Math.round(origin.size + sizeStep * unit);
          const x = Math.round(origin.x + (origin.size - size) / 2);
          const y = Math.round(origin.y + (origin.size - size) / 2 + yStep * unit);
          if (size < 16 || x < 0 || y < 0 || x + size > dimensions.width || y + size > dimensions.height) continue;
          const score = checkerScore(sourceImage, x, y, size, true);
          const next = evaluateLocation({
            board: { x, y, size },
            confidence: clamp((score - 4) / 14),
            score
          });
          if (next.rank > best.rank) best = next;
          if (best.squares.filter(Boolean).length >= 27 && best.pieceEvidence > 15) break refineCandidates;
        }
      }
    }
  }

  if (!options.board && best.squares.filter(Boolean).length < 27) {
    const origin = best.location.board;
    let step = Math.max(2, Math.round(origin.size * 0.04));
    while (true) {
      for (const axis of ['size', 'x', 'y']) {
        for (const direction of [-1, 1]) {
          let { x, y, size } = best.location.board;
          if (axis === 'size') {
            const nextSize = size + direction * step;
            x = Math.round(x + (size - nextSize) / 2);
            y = Math.round(y + (size - nextSize) / 2);
            size = nextSize;
          } else if (axis === 'x') {
            x += direction * step;
          } else {
            y += direction * step;
          }
          if (size < 16 || x < 0 || y < 0 || x + size > dimensions.width || y + size > dimensions.height ||
              Math.abs(x - origin.x) > origin.size * 0.2 ||
              Math.abs(y - origin.y) > origin.size * 0.2 ||
              Math.abs(size - origin.size) > origin.size * 0.2) continue;
          const score = checkerScore(sourceImage, x, y, size, true);
          const next = evaluateLocation({
            board: { x, y, size },
            confidence: clamp((score - 4) / 14),
            score
          });
          if (next.rank > best.rank) best = next;
        }
      }
      if (step === 1) break;
      step = Math.max(1, Math.floor(step / 2));
    }
  }

  if (!options.board && best.squares.filter(Boolean).length < 28 && best.pieceEvidence < 10) {
    const origin = best.location.board;
    const offsets = [-12, -8, -4, 0, 4, 8, 12];
    for (const sizeOffset of offsets) {
      for (const xOffset of offsets) {
        for (const yOffset of offsets) {
          const x = origin.x + xOffset;
          const y = origin.y + yOffset;
          const size = origin.size + sizeOffset;
          if (size < 16 || x < 0 || y < 0 || x + size > dimensions.width || y + size > dimensions.height) continue;
          const score = checkerScore(sourceImage, x, y, size, true);
          const next = evaluateLocation({
            board: { x, y, size },
            confidence: clamp((score - 4) / 14),
            score
          });
          if (next.rank > best.rank) best = next;
        }
      }
    }
  }

  if (!options.board && ((best.squares.filter(Boolean).length < 28 && best.pieceEvidence < 20) ||
      (best.squares.filter(Boolean).length >= 28 && best.squares.filter(Boolean).length < 32))) {
    const origin = best.location.board;
    const offsets = [-3, -2, -1, 0, 1, 2, 3];
    for (const sizeOffset of offsets) {
      for (const xOffset of offsets) {
        for (const yOffset of offsets) {
          const x = origin.x + xOffset;
          const y = origin.y + yOffset;
          const size = origin.size + sizeOffset;
          if (size < 16 || x < 0 || y < 0 || x + size > dimensions.width || y + size > dimensions.height) continue;
          const score = checkerScore(sourceImage, x, y, size, true);
          const next = evaluateLocation({
            board: { x, y, size },
            confidence: clamp((score - 4) / 14),
            score
          });
          if (next.rank > best.rank) best = next;
        }
      }
    }
  }

  const { squares, cellResults, location } = best;
  const orientation = options.orientation === 'white' || options.orientation === 'black'
    ? options.orientation
    : detectOrientation(squares);
  const meanCellConfidence = cellResults.reduce((sum, cell) => sum + cell.confidence, 0) / 64;
  const confidence = clamp(meanCellConfidence * 0.9 + location.confidence * 0.1);
  return {
    squares,
    orientation,
    confidence,
    cellResults,
    board: location.board
  };
}

export function drawRecognitionPreview(source, result, canvas) {
  if (!result || !result.board || !Array.isArray(result.squares) || result.squares.length !== 64) {
    throw new TypeError('A complete recognition result is required.');
  }
  const { width, height } = sourceDimensions(source);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0);
  const { x, y, size } = result.board;
  const cell = size / BOARD_SIZE;
  context.save();
  context.lineWidth = Math.max(1, size / 500);
  context.font = `bold ${Math.max(10, cell * 0.2)}px sans-serif`;
  context.textBaseline = 'top';
  for (let index = 0; index < 64; index++) {
    const col = index % BOARD_SIZE;
    const row = Math.floor(index / BOARD_SIZE);
    const confidence = result.cellResults[index].confidence;
    context.strokeStyle = confidence < 0.6 ? '#ff5f57' : '#54e68a';
    context.strokeRect(x + col * cell + 1, y + row * cell + 1, cell - 2, cell - 2);
    const piece = result.squares[index];
    if (piece) {
      context.fillStyle = '#ffffff';
      context.fillText(piece, x + (col + 0.05) * cell, y + (row + 0.03) * cell);
    }
  }
  context.restore();
  return canvas;
}
