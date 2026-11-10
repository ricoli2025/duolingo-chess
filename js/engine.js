const DRAW_RANGE_CP = 25;

function pickMove(engineBest, active) {
  const { pvMap, sideToMove, playerColor, avoidDraw } = active;
  if (!avoidDraw || !pvMap.size) return engineBest;
  const toPlayer = cp => (sideToMove === playerColor ? cp : -cp);
  const playerValue = entry => {
    if (entry.kind === 'mate') {
      const winning = (entry.value > 0) === (sideToMove === playerColor);
      return winning ? 100000 - Math.abs(entry.value) : -100000 + Math.abs(entry.value);
    }
    return toPlayer(entry.value);
  };
  const entries = [...pvMap.values()].sort((a, b) => playerValue(b) - playerValue(a));
  const best = entries.find(entry => entry.move === engineBest) || entries[0];
  // Engine's top choice already has a clear edge (or clear deficit): keep it.
  if (Math.abs(playerValue(best)) >= DRAW_RANGE_CP) return engineBest;
  // Top choice drifts toward a draw: prefer the best alternative that keeps
  // the game unbalanced, so Duolingo does not settle for a draw.
  let chosen = null;
  for (const entry of entries) {
    if (entry.move === best.move) continue;
    const value = playerValue(entry);
    if (Math.abs(value) < DRAW_RANGE_CP) continue;
    if (!chosen || value > chosen.value) chosen = { move: entry.move, value };
  }
  return chosen ? chosen.move : engineBest;
}

export class StockfishEngine {
  constructor() {
    this.worker = null;
    this.ready = null;
    this.active = null;
  }

  async initialize(onProgress = () => {}) {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../vendor/stockfish-19-lite-single.js', import.meta.url));
      this.worker = worker;
      const timeout = setTimeout(() => {
        this.reset();
        reject(new Error('引擎加载超时，请重试'));
      }, 60000);
      worker.onmessage = (event) => {
        const line = event.data;
        if (typeof line === 'object' && line && Number.isFinite(line.percent)) {
          onProgress({ type: 'download', percent: line.percent });
          return;
        }
        if (typeof line !== 'string') return;
        if (line === 'uciok') {
          worker.postMessage('setoption name Hash value 16');
          worker.postMessage('isready');
        } else if (line === 'readyok') {
          clearTimeout(timeout);
          worker.onmessage = (event) => this.handleMessage(event.data);
          resolve();
        }
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        this.reset();
        reject(new Error('引擎无法启动，请通过本地服务器或 HTTPS 打开页面'));
      };
      worker.postMessage('uci');
    });
    return this.ready;
  }

  handleMessage(line) {
    if (typeof line !== 'string' || !this.active) return;
    const { onProgress } = this.active;
    if (line.startsWith('info ')) {
      const depth = line.match(/\bdepth (\d+)/);
      const score = line.match(/\bscore (cp|mate) (-?\d+)/);
      if (depth) onProgress({ type: 'search', depth: Number(depth[1]), score: score ? `${score[1]} ${score[2]}` : '' });
      const multipv = line.match(/\bmultipv (\d+)/);
      const pvMove = line.match(/\bpv (\S+)/);
      if (multipv && score && pvMove) {
        // Keep the latest (deepest) evaluation per principal variation.
        this.active.pvMap.set(Number(multipv[1]), {
          kind: score[1],
          value: Number(score[2]),
          move: pvMove[1]
        });
      }
    }
    const match = line.match(/^bestmove (\S+)/);
    if (!match) return;
    const active = this.active;
    this.active = null;
    clearTimeout(active.timeout);
    active.resolve(pickMove(match[1], active));
  }

  async analyze(fen, movetime, onProgress = () => {}, options = {}) {
    await this.initialize(onProgress);
    if (!this.worker || this.active) throw new Error('引擎正在计算，请稍候');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.active = null;
        this.reset();
        reject(new Error('计算超时，请重试'));
      }, movetime + 15000);
      this.active = {
        resolve,
        reject,
        onProgress,
        timeout,
        pvMap: new Map(),
        sideToMove: (fen.split(' ')[1] || 'w').toLowerCase(),
        playerColor: options.playerColor === 'b' ? 'b' : 'w',
        avoidDraw: Boolean(options.avoidDraw)
      };
      this.worker.postMessage('setoption name MultiPV value 3');
      this.worker.postMessage('ucinewgame');
      this.worker.postMessage('isready');
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go movetime ${movetime}`);
    });
  }

  reset() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = null;
    this.active = null;
  }
}
