import { Chess } from '../vendor/chess.js';
import { recognizeBoard } from './recognition.js';
import { StockfishEngine } from './engine.js';

const PIECES = Object.fromEntries(
  [...'KQRBNPkqrbnp'].map((piece) => [
    piece,
    `assets/pieces/${piece}${piece === piece.toUpperCase() ? '.white' : ''}.png`
  ])
);
const NAMES = { K: '白王', Q: '白后', R: '白车', B: '白象', N: '白马', P: '白兵', k: '黑王', q: '黑后', r: '黑车', b: '黑象', n: '黑马', p: '黑兵' };
const PROMOTIONS = { q: '后', r: '车', b: '象', n: '马' };
const FILES = 'abcdefgh';
const elements = Object.fromEntries([
  'screenshot-input', 'preview-section', 'screenshot-preview', 'status',
  'position-section', 'confidence', 'board', 'orientation', 'turn', 'castling',
  'analyze-button', 'result-section', 'best-move', 'uci-move', 'engine-detail'
].map((id) => [id, document.getElementById(id)]));

const state = {
  squares: Array(64).fill(null),
  orientation: 'white',
  turn: 'bottom',
  castling: 'none',
  confidence: 1,
  analyzing: false,
  bestMove: null
};
const engine = new StockfishEngine();

function setStatus(message, type = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;
}

function opposite(color) {
  return color === 'white' ? 'black' : 'white';
}

function squareName(index, orientation = state.orientation) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  const rank = orientation === 'white' ? 8 - row : row + 1;
  const file = orientation === 'white' ? col : 7 - col;
  return `${FILES[file]}${rank}`;
}

function indexFromName(name) {
  const file = FILES.indexOf(name[0]);
  const rank = Number(name[1]);
  const row = state.orientation === 'white' ? 8 - rank : rank - 1;
  const col = state.orientation === 'white' ? file : 7 - file;
  return row * 8 + col;
}

function renderBoard() {
  const fragment = document.createDocumentFragment();
  state.squares.forEach((piece, index) => {
    const row = Math.floor(index / 8);
    const col = index % 8;
    const name = squareName(index);
    const square = document.createElement('div');
    square.className = `square ${(row + col) % 2 ? 'light' : 'dark'}`;
    if (state.bestMove) {
      if (indexFromName(state.bestMove.slice(0, 2)) === index) square.classList.add('move-from');
      if (indexFromName(state.bestMove.slice(2, 4)) === index) square.classList.add('move-to');
    }
    square.setAttribute('role', 'gridcell');
    square.setAttribute('aria-label', `${name} ${piece ? NAMES[piece] : '空格'}`);
    if (piece) {
      const image = document.createElement('img');
      image.className = 'piece-image';
      image.src = PIECES[piece];
      image.alt = '';
      square.append(image);
    }
    const coordinate = document.createElement('small');
    coordinate.className = 'coordinate';
    coordinate.textContent = name;
    square.append(coordinate);
    fragment.append(square);
  });
  elements.board.replaceChildren(fragment);
}

function clearResult() {
  state.bestMove = null;
  elements['result-section'].hidden = true;
  elements['best-move'].textContent = '';
  elements['uci-move'].textContent = '';
  elements['engine-detail'].textContent = '';
}

function renderPosition() {
  elements['position-section'].hidden = false;
  elements.orientation.value = state.orientation;
  elements.turn.value = state.turn;
  elements.castling.value = state.castling;
  elements.confidence.textContent = `识别可信度 ${Math.round(state.confidence * 100)}%`;
  renderBoard();
}

function logicalPlacement() {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const displayRow = state.orientation === 'white' ? 8 - rank : rank - 1;
      const displayCol = state.orientation === 'white' ? file : 7 - file;
      const piece = state.squares[displayRow * 8 + displayCol];
      if (!piece) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += piece;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

function castlingRights() {
  if (state.castling === 'none') return '-';
  const chess = new Chess();
  chess.clear();
  for (let rank = 8; rank >= 1; rank--) {
    for (let file = 0; file < 8; file++) {
      const displayRow = state.orientation === 'white' ? 8 - rank : rank - 1;
      const displayCol = state.orientation === 'white' ? file : 7 - file;
      const piece = state.squares[displayRow * 8 + displayCol];
      if (piece) chess.put({ type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w' : 'b' }, `${FILES[file]}${rank}`);
    }
  }
  const at = (name) => chess.get(name);
  let rights = '';
  if (at('e1')?.type === 'k' && at('e1')?.color === 'w') {
    if (at('h1')?.type === 'r' && at('h1')?.color === 'w') rights += 'K';
    if (at('a1')?.type === 'r' && at('a1')?.color === 'w') rights += 'Q';
  }
  if (at('e8')?.type === 'k' && at('e8')?.color === 'b') {
    if (at('h8')?.type === 'r' && at('h8')?.color === 'b') rights += 'k';
    if (at('a8')?.type === 'r' && at('a8')?.color === 'b') rights += 'q';
  }
  return rights || '-';
}

function currentFen() {
  const turn = state.turn === 'bottom' ? state.orientation : opposite(state.orientation);
  return `${logicalPlacement()} ${turn === 'white' ? 'w' : 'b'} ${castlingRights()} - 0 1`;
}

function validatePosition() {
  const kings = state.squares.filter((piece) => piece === 'K').length;
  const blackKings = state.squares.filter((piece) => piece === 'k').length;
  if (kings !== 1 || blackKings !== 1) throw new Error('棋盘必须恰好各有一个白王和黑王');
  const fen = currentFen();
  const game = new Chess(fen);
  return { fen, game };
}

async function loadScreenshot(file) {
  if (!file) return;
  clearResult();
  elements['position-section'].hidden = true;
  elements['preview-section'].hidden = false;
  setStatus('正在读取截图…', 'busy');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('图片读取失败'));
      image.src = url;
    });
    const canvas = elements['screenshot-preview'];
    const scale = Math.min(1, 700 / image.naturalWidth);
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    setStatus('正在识别棋盘…', 'busy');
    const result = await recognizeBoard(image);
    state.squares = result.squares;
    state.orientation = result.orientation;
    state.turn = 'bottom';
    state.confidence = result.confidence;
    renderPosition();
    setStatus('识别完成，可以直接计算着法。');
  } catch (error) {
    console.error(error);
    setStatus(`${error.message || '无法识别这张图'}。请重新截取完整棋盘。`, 'error');
  } finally {
    URL.revokeObjectURL(url);
    elements['screenshot-input'].value = '';
  }
}

async function analyze() {
  if (state.analyzing) return;
  clearResult();
  renderBoard();
  let position;
  try {
    position = validatePosition();
  } catch (error) {
    setStatus(`局面无效：${error.message}`, 'error');
    return;
  }
  if (state.confidence < 0.35) {
    setStatus('无法可靠读取棋盘，请重新截取完整棋盘。', 'error');
    return;
  }
  if (position.game.isCheckmate()) {
    setStatus('当前是将杀，没有可走的棋。');
    return;
  }
  if (position.game.isStalemate()) {
    setStatus('当前是逼和，没有可走的棋。');
    return;
  }
  if (position.game.isDraw()) {
    setStatus('当前局面按规则已经和棋，没有需要计算的下法。');
    return;
  }

  state.analyzing = true;
  elements['analyze-button'].disabled = true;
  elements['analyze-button'].textContent = '正在加载引擎…';
  setStatus('首次启动引擎可能需要几秒。', 'busy');
  elements['result-section'].hidden = false;
  elements['best-move'].textContent = '计算中…';
  try {
    const started = performance.now();
    const bestMove = await engine.analyze(position.fen, 3500, (progress) => {
      if (progress.type === 'download') {
        elements['engine-detail'].textContent = `引擎加载 ${Math.round(progress.percent * 100)}%`;
      } else if (progress.type === 'search') {
        elements['analyze-button'].textContent = `正在计算 · 深度 ${progress.depth}`;
        elements['engine-detail'].textContent = `Stockfish 19 · 搜索深度 ${progress.depth}`;
      }
    });
    if (bestMove === '(none)' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMove)) throw new Error('引擎没有返回有效着法');
    const legal = position.game.moves({ verbose: true }).some((move) => move.from === bestMove.slice(0, 2) && move.to === bestMove.slice(2, 4) && (!move.promotion || move.promotion === bestMove[4]));
    if (!legal) throw new Error('识别结果与下棋规则不符，请重新截图');
    state.bestMove = bestMove;
    const promotion = bestMove[4] ? `（升变为${PROMOTIONS[bestMove[4]]}）` : '';
    elements['best-move'].textContent = `${bestMove.slice(0, 2)} → ${bestMove.slice(2, 4)}${promotion}`;
    elements['uci-move'].textContent = bestMove;
    elements['engine-detail'].textContent = `Stockfish 19 · 用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
    setStatus('计算完成。绿色格是终点，黄色格是起点。');
    renderBoard();
  } catch (error) {
    console.error(error);
    elements['result-section'].hidden = true;
    setStatus(error.message || '计算失败，请重试', 'error');
  } finally {
    state.analyzing = false;
    elements['analyze-button'].disabled = false;
    elements['analyze-button'].textContent = '重新计算最佳着法';
  }
}

elements['screenshot-input'].addEventListener('change', (event) => loadScreenshot(event.target.files[0]));
elements['analyze-button'].addEventListener('click', analyze);
elements.orientation.addEventListener('change', () => {
  state.orientation = elements.orientation.value;
  clearResult();
  renderBoard();
});
elements.turn.addEventListener('change', () => {
  state.turn = elements.turn.value;
  clearResult();
  renderBoard();
});
elements.castling.addEventListener('change', () => {
  state.castling = elements.castling.value;
  clearResult();
  renderBoard();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
