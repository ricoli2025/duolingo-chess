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
      }, 25000);
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
    }
    const match = line.match(/^bestmove (\S+)/);
    if (!match) return;
    const active = this.active;
    this.active = null;
    clearTimeout(active.timeout);
    active.resolve(match[1]);
  }

  async analyze(fen, movetime, onProgress = () => {}) {
    await this.initialize(onProgress);
    if (!this.worker || this.active) throw new Error('引擎正在计算，请稍候');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.active = null;
        this.reset();
        reject(new Error('计算超时，请重试'));
      }, movetime + 15000);
      this.active = { resolve, reject, onProgress, timeout };
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
