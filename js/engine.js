// Stockfish 17.1 lite (single-threaded WASM) in a worker. One position at a time, queued.
let worker = null;
let ready = null;
let queue = Promise.resolve();

function start() {
  if (ready) return ready;
  worker = new Worker('vendor/stockfish.js');
  ready = new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (String(e.data).startsWith('readyok')) { worker.removeEventListener('message', onMsg); resolve(); }
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', (e) => reject(e));
    worker.postMessage('uci');
    worker.postMessage('setoption name Hash value 16');
    worker.postMessage('isready');
  });
  return ready;
}

/**
 * Evaluate a position. Returns { cp, mate, best, pv } from the side to move's point of view.
 * cp: centipawns (null when mate). mate: moves to mate (+ = side to move mates, - = gets mated).
 */
export function evaluate(fen, { depth = 12, movetime = 700 } = {}) {
  const job = queue.then(() => start()).then(() => new Promise((resolve) => {
    let last = { cp: 0, mate: null, pv: [] };
    const onMsg = (e) => {
      const line = String(e.data);
      if (line.startsWith('info') && line.includes(' pv ') && !/multipv [2-9]/.test(line)) {
        const cp = line.match(/score cp (-?\d+)/);
        const mate = line.match(/score mate (-?\d+)/);
        const pv = line.split(' pv ')[1].trim().split(/\s+/);
        last = { cp: cp ? +cp[1] : null, mate: mate ? +mate[1] : null, pv };
      } else if (line.startsWith('bestmove')) {
        worker.removeEventListener('message', onMsg);
        const best = line.split(/\s+/)[1];
        if (best === '(none)') { resolve({ ...last, best: null, pv: [] }); return; }
        if (!last.pv.length || last.pv[0] !== best) last.pv = [best];
        resolve({ ...last, best });
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage('position fen ' + fen);
    worker.postMessage(`go depth ${depth} movetime ${movetime}`);
  }));
  queue = job.catch(() => {});
  return job;
}

export function engineReady() { return start(); }
