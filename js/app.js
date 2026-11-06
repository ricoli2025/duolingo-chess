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
  'analyze-button', 'result-section', 'best-move', 'uci-move', 'engine-detail',
  'confirm-move', 'promotion-dialog', 'promotion-options'
].map((id) => [id, document.getElementById(id)]));

const state = {
  squares: Array(64).fill(null),
  orientation: 'white',
  turn: 'bottom',
  castling: 'none',
  confidence: 1,
  game: null,
  selected: null,
  legalMoves: [],
  pendingPromotion: null,
  analyzing: false,
  analysisId: 0,
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

function playerColor() {
  return state.orientation === 'white' ? 'w' : 'b';
}

function opponentColor() {
  return playerColor() === 'w' ? 'b' : 'w';
}

function squareName(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  const rank = state.orientation === 'white' ? 8 - row : row + 1;
  const file = state.orientation === 'white' ? col : 7 - col;
  return `${FILES[file]}${rank}`;
}

function indexFromName(name) {
  const file = FILES.indexOf(name[0]);
  const rank = Number(name[1]);
  const row = state.orientation === 'white' ? 8 - rank : rank - 1;
  const col = state.orientation === 'white' ? file : 7 - file;
  return row * 8 + col;
}

function resetSelection() {
  state.selected = null;
  state.legalMoves = [];
}

function gameOverMessage() {
  if (!state.game) return '';
  if (state.game.isCheckmate()) return '将杀，对局结束。';
  if (state.game.isStalemate()) return '逼和，对局结束。';
  if (state.game.isDraw()) return '按规则和棋，对局结束。';
  return '';
}

function syncFromGame() {
  const board = state.game.board();
  state.squares = [];
  const rows = state.orientation === 'white' ? board : [...board].reverse();
  for (const row of rows) {
    const cells = state.orientation === 'white' ? row : [...row].reverse();
    for (const cell of cells) {
      state.squares.push(cell ? (cell.color === 'w' ? cell.type.toUpperCase() : cell.type) : null);
    }
  }
}

function renderBoard() {
  const canMove = state.game && !state.analyzing && !state.bestMove &&
    state.game.turn() === opponentColor() && !state.game.isGameOver();
  const fragment = document.createDocumentFragment();
  state.squares.forEach((piece, index) => {
    const row = Math.floor(index / 8);
    const col = index % 8;
    const name = squareName(index);
    const square = document.createElement('button');
    square.type = 'button';
    square.className = `square ${(row + col) % 2 ? 'light' : 'dark'}`;
    square.dataset.square = name;
    square.disabled = !canMove;
    if (state.selected === name) square.classList.add('selected');
    const target = state.legalMoves.find((move) => move.to === name);
    if (target) square.classList.add(target.captured ? 'legal-capture' : 'legal-target');
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
  elements['confirm-move'].hidden = true;
  elements['best-move'].textContent = '';
  elements['uci-move'].textContent = '';
  elements['engine-detail'].textContent = '';
}

function renderPosition() {
  elements['position-section'].hidden = false;
  elements.orientation.value = state.orientation;
  elements.turn.value = state.turn;
  elements.castling.value = state.castling;
  elements.orientation.disabled = Boolean(state.game);
  elements.turn.disabled = Boolean(state.game);
  elements.castling.disabled = Boolean(state.game);
  elements.confidence.textContent = `识别可信度 ${Math.round(state.confidence * 100)}%`;
  if (!state.analyzing) {
    elements['analyze-button'].textContent = state.game ? '重新计算最新着法' : '计算最佳着法';
  }
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
  const whiteKings = state.squares.filter((piece) => piece === 'K').length;
  const blackKings = state.squares.filter((piece) => piece === 'k').length;
  if (whiteKings !== 1 || blackKings !== 1) throw new Error('棋盘必须恰好各有一个白王和黑王');
  return new Chess(currentFen());
}

function finishMove(message) {
  syncFromGame();
  resetSelection();
  clearResult();
  renderPosition();
  setStatus(gameOverMessage() || message);
}

function confirmBestMove() {
  if (!state.game || !state.bestMove) return;
  const move = state.bestMove;
  try {
    state.game.move({
      from: move.slice(0, 2),
      to: move.slice(2, 4),
      promotion: move[4]
    });
    finishMove(`下方已走 ${move}。现在请移动上方棋子。`);
  } catch {
    setStatus('建议着法执行失败，请重新计算。', 'error');
  }
}

function performManualMove(move, promotion) {
  try {
    state.game.move({ from: move.from, to: move.to, promotion });
    finishMove(`上方已走 ${move.from}${move.to}${promotion || ''}。点击“重新计算最新着法”。`);
  } catch {
    setStatus('这不是合法着法，请重新选择。', 'error');
  }
}

function choosePromotion(move) {
  state.pendingPromotion = move;
  const fragment = document.createDocumentFragment();
  for (const type of ['q', 'r', 'b', 'n']) {
    const piece = opponentColor() === 'w' ? type.toUpperCase() : type;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'promotion-option';
    button.dataset.promotion = type;
    button.setAttribute('aria-label', `升变为${PROMOTIONS[type]}`);
    const image = document.createElement('img');
    image.className = 'piece-image';
    image.src = PIECES[piece];
    image.alt = PROMOTIONS[type];
    button.append(image);
    fragment.append(button);
  }
  elements['promotion-options'].replaceChildren(fragment);
  elements['promotion-dialog'].showModal();
}

function selectBoardSquare(name) {
  if (!state.game || state.analyzing || state.bestMove) return;
  const over = gameOverMessage();
  if (over) {
    setStatus(over);
    return;
  }
  if (state.game.turn() !== opponentColor()) {
    setStatus('现在应由下方走棋，请先计算并确认建议。');
    return;
  }
  const piece = state.game.get(name);
  if (state.selected) {
    const move = state.legalMoves.find((candidate) => candidate.to === name);
    if (move) {
      if (move.promotion) choosePromotion(move);
      else performManualMove(move);
      return;
    }
    if (state.selected === name) {
      resetSelection();
      renderBoard();
      return;
    }
  }
  if (piece?.color === opponentColor()) {
    state.selected = name;
    state.legalMoves = state.game.moves({ square: name, verbose: true });
    setStatus(`已选择 ${name}，请选择高亮的合法落点。`);
    renderBoard();
  } else if (state.selected) {
    setStatus('这个格子不是合法落点，请重新选择。', 'error');
  } else {
    setStatus('请先选择一个上方棋子。');
  }
}

async function loadScreenshot(file) {
  if (!file) return;
  state.analysisId++;
  engine.reset();
  state.analyzing = false;
  state.game = null;
  state.pendingPromotion = null;
  resetSelection();
  clearResult();
  if (elements['promotion-dialog'].open) elements['promotion-dialog'].close();
  elements['position-section'].hidden = true;
  elements['preview-section'].hidden = false;
  elements['analyze-button'].disabled = false;
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
  if (state.analyzing || state.bestMove) return;
  if (state.game && state.game.turn() !== playerColor()) {
    setStatus('请先移动上方棋子，再重新计算。');
    return;
  }
  clearResult();
  resetSelection();
  renderBoard();
  try {
    if (!state.game) state.game = validatePosition();
  } catch (error) {
    setStatus(`局面无效：${error.message}`, 'error');
    return;
  }
  renderPosition();
  if (state.confidence < 0.35) {
    setStatus('无法可靠读取棋盘，请重新截取完整棋盘。', 'error');
    return;
  }
  const over = gameOverMessage();
  if (over) {
    setStatus(over);
    return;
  }

  const analysisId = ++state.analysisId;
  const game = state.game;
  state.analyzing = true;
  elements['analyze-button'].disabled = true;
  elements['analyze-button'].textContent = '正在加载引擎…';
  setStatus('正在计算下方最佳着法。', 'busy');
  elements['result-section'].hidden = false;
  elements['best-move'].textContent = '计算中…';
  try {
    const started = performance.now();
    const bestMove = await engine.analyze(game.fen(), 3500, (progress) => {
      if (analysisId !== state.analysisId) return;
      if (progress.type === 'download') {
        elements['engine-detail'].textContent = `引擎加载 ${Math.round(progress.percent * 100)}%`;
      } else if (progress.type === 'search') {
        elements['analyze-button'].textContent = `正在计算 · 深度 ${progress.depth}`;
        elements['engine-detail'].textContent = `Stockfish 19 · 搜索深度 ${progress.depth}`;
      }
    });
    if (analysisId !== state.analysisId || game !== state.game) return;
    if (bestMove === '(none)' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMove)) throw new Error('引擎没有返回有效着法');
    const legal = game.moves({ verbose: true }).some((move) => move.from === bestMove.slice(0, 2) && move.to === bestMove.slice(2, 4) && (!move.promotion || move.promotion === bestMove[4]));
    if (!legal) throw new Error('识别结果与下棋规则不符，请重新截图');
    state.bestMove = bestMove;
    elements['confirm-move'].hidden = false;
    const promotion = bestMove[4] ? `（升变为${PROMOTIONS[bestMove[4]]}）` : '';
    elements['best-move'].textContent = `${bestMove.slice(0, 2)} → ${bestMove.slice(2, 4)}${promotion}`;
    elements['uci-move'].textContent = bestMove;
    elements['engine-detail'].textContent = `Stockfish 19 · 用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
    setStatus('建议已生成。点击“确认着子”自动落子，再移动上方棋子。');
    renderBoard();
  } catch (error) {
    if (analysisId !== state.analysisId) return;
    console.error(error);
    elements['result-section'].hidden = true;
    setStatus(error.message || '计算失败，请重试', 'error');
  } finally {
    if (analysisId === state.analysisId) {
      state.analyzing = false;
      elements['analyze-button'].disabled = false;
      elements['analyze-button'].textContent = '重新计算最新着法';
    }
  }
}

elements['screenshot-input'].addEventListener('change', (event) => loadScreenshot(event.target.files[0]));
elements['analyze-button'].addEventListener('click', analyze);
elements['confirm-move'].addEventListener('click', confirmBestMove);
elements.board.addEventListener('click', (event) => {
  const square = event.target.closest('button[data-square]');
  if (square) selectBoardSquare(square.dataset.square);
});
elements['promotion-options'].addEventListener('click', (event) => {
  const button = event.target.closest('button[data-promotion]');
  if (!button || !state.pendingPromotion) return;
  const move = state.pendingPromotion;
  state.pendingPromotion = null;
  elements['promotion-dialog'].close();
  performManualMove(move, button.dataset.promotion);
});
elements['promotion-dialog'].addEventListener('cancel', () => {
  state.pendingPromotion = null;
  resetSelection();
  renderBoard();
});
elements.orientation.addEventListener('change', () => {
  if (state.game) return;
  state.orientation = elements.orientation.value;
  clearResult();
  renderBoard();
});
elements.turn.addEventListener('change', () => {
  if (state.game) return;
  state.turn = elements.turn.value;
  clearResult();
  renderBoard();
});
elements.castling.addEventListener('change', () => {
  if (state.game) return;
  state.castling = elements.castling.value;
  clearResult();
  renderBoard();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const updateWorker = () => {
    navigator.serviceWorker.register('sw.js').then((registration) => registration.update()).catch(() => {});
  };
  updateWorker();
  window.addEventListener('pageshow', updateWorker);
}
