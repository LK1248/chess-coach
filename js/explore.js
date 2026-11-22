// "Try it yourself": the user moves pieces on the board, the engine judges each move in plain English and answers.
import { Chess } from '../vendor/chess.js';
import { evaluate } from './engine.js';
import { explain, describeMove, winChance, NAME, CATEGORIES } from './analyze.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * After a move lands on `sq`, what does that piece now threaten? Plain English, or '' if nothing notable.
 * `viewer` is the user's colour, so the wording says "your"/"their" correctly.
 */
export function threatNote(chess, sq, viewer) {
  const piece = chess.get(sq);
  if (!piece) return '';
  const victimSide = piece.color === 'w' ? 'b' : 'w';
  const owner = victimSide === viewer ? 'your' : 'their';
  const hits = [];
  for (const row of chess.board()) for (const p of row) {
    if (!p || p.color !== victimSide) continue;
    if (!chess.attackers(p.square, piece.color).includes(sq)) continue;
    const defended = chess.attackers(p.square, victimSide).length > 0;
    if (p.type === 'k') continue; // the move text already says "giving check"
    if (!defended && p.type !== 'p') hits.push(`${owner} ${NAME[p.type]}, which has no protection`);
    else if (VAL[p.type] > VAL[piece.type]) hits.push(`${owner} ${NAME[p.type]}, which is worth more than it`);
  }
  if (!hits.length) return '';
  const list = hits.length === 1 ? hits[0] : `${hits.slice(0, -1).join(', ')} and ${hits[hits.length - 1]}`;
  return `It now attacks ${list}.`;
}

/** Was the piece just captured on `to` unprotected before the capture? (fenBefore = position before the capturing move) */
export function captureNote(fenBefore, uci, viewer) {
  const c = new Chess(fenBefore);
  const target = c.get(uci.slice(2, 4));
  if (!target) return '';
  const owner = target.color === viewer ? 'Your' : 'Their';
  const defenders = c.attackers(uci.slice(2, 4), target.color).length;
  return defenders ? '' : `${owner} ${NAME[target.type]} had nothing protecting it.`;
}

export function startExplore({ board, panel, fen, me, flip, opts, onExit }) {
  const chess = new Chess(fen);
  const startFen = fen;
  let e0 = null;            // evaluation of the current position (me to move)
  let busy = false;
  let selected = null;
  let last = null;
  let arrows = [];
  let feed = '';            // html of the latest feedback
  let lastChances = null;
  const undo = [];          // snapshots before each of my moves
  let alive = true;

  const theirTurn = () => chess.turn() !== me;

  function paint() {
    const dots = selected ? chess.moves({ square: selected, verbose: true }).map((m) => ({ sq: m.to, capture: !!m.captured })) : [];
    board.draw({ fen: chess.fen(), flip, last, selected, dots, arrows });
  }

  function render() {
    const over = chess.isGameOver();
    panel.innerHTML = `<section class="card explore">
      <div class="mhead"><b>Try it yourself</b>${lastChances !== null ? `<small class="muted">your winning chances: ${lastChances}%</small>` : ''}</div>
      <div class="feed">${feed || `<p class="muted">You're playing ${me === 'w' ? 'White' : 'Black'}. Tap one of your pieces, then the square to move it to. I'll tell you what I think and answer with the best reply.</p>`}</div>
      ${busy ? '<p class="muted thinking">Thinking…</p>' : ''}
      <div class="btns">
        <button class="pill" data-x="undo" ${!undo.length || busy ? 'disabled' : ''}>↶ Undo</button>
        <button class="pill" data-x="hint" ${busy || over || theirTurn() ? 'disabled' : ''}>💡 Hint</button>
        <button class="pill" data-x="reset" ${busy ? 'disabled' : ''}>Start over</button>
        <button class="pill" data-x="done">Done</button>
      </div>
    </section>`;
    panel.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => act(b.dataset.x)));
  }

  async function ensureEval() {
    if (!e0) e0 = await evaluate(chess.fen(), opts);
    lastChances = Math.round(winChance(e0));
    return e0;
  }

  async function engineMove(prefix = '') {
    const before = chess.fen();
    const e = await evaluate(before, opts);
    if (!alive || !e.best) return;
    const uci = e.best;
    const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    last = { from: m.from, to: m.to };
    const why = [captureNote(before, uci, me), threatNote(chess, m.to, me)].filter(Boolean).join(' ');
    let text = `<p class="reply"><b>They answer:</b> ${esc(cap(describeMove(before, uci, 'their')))}.${why ? ` ${esc(why)}` : ''}</p>`;
    if (chess.isCheckmate()) text += '<p><b>Checkmate — you lost this line.</b> Undo and try something else.</p>';
    feed = prefix + text;
    e0 = null;
  }

  let pending = null;       // a mistake held back so the user can choose
  async function play(from, to, force = false) {
    const fenBefore = chess.fen();
    const piece = chess.get(from);
    const promotion = piece?.type === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
    let m;
    try { m = chess.move({ from, to, promotion }); } catch { return; }
    selected = null; arrows = []; last = { from: m.from, to: m.to };
    undo.push({ fen: fenBefore, e0, feed, last: null, lastChances });
    busy = true; paint(); render();
    try {
      chess.undo();
      const ev0 = await ensureEval();
      chess.move({ from, to, promotion });
      const myUci = m.from + m.to + (m.promotion || '');
      let verdict;
      if (chess.isCheckmate()) {
        verdict = '<p class="verdict good"><b>Checkmate!</b> You win this line.</p>';
        feed = verdict; busy = false; lastChances = 100; paint(); render(); return;
      }
      const e1 = await evaluate(chess.fen(), opts);
      if (!alive) return;
      const before = winChance(ev0), after = 100 - winChance(e1);
      const drop = before - after;
      const said = cap(describeMove(fenBefore, myUci, 'you'));
      if (myUci === ev0.best || drop < 2) verdict = `<p class="verdict good"><b>Great move.</b> ${esc(said)} — that's what the engine would play too.</p>`;
      else if (drop < 6) verdict = `<p class="verdict good"><b>Good move.</b> ${esc(said)}.</p>`;
      else if (drop < 10) verdict = `<p class="verdict warn"><b>OK, but there was something better.</b> ${esc(said)}. Tap Undo and Hint if you want to see it.</p>`;
      else {
        const x = explain({ fen0: fenBefore, san: m.san, e0: ev0, e1, me, clockLeft: null, base: 0, ply: 40 });
        verdict = `<p class="verdict bad"><b>${drop >= 20 ? 'Big mistake' : 'Mistake'}: ${esc(CATEGORIES[x.category].label.toLowerCase())}.</b> ${esc(x.text)}</p>`;
        if (!force) {
          // hold the move back: show it (red) next to the better move (green) on the position before it
          chess.undo(); undo.pop();
          last = null; lastChances = Math.round(before);
          arrows = x.arrows.filter((a) => a.color !== 'threat');
          pending = { from, to };
          feed = verdict + `<div class="btns"><button class="pill" data-x="again">Try again</button><button class="pill" data-x="anyway">Play it anyway</button></div>`;
          return;
        }
        verdict = verdict.replace(' (green arrow)', '');
      }
      lastChances = Math.round(after);
      if (!chess.isGameOver()) {
        await engineMove(verdict);
        const lost = chess.get(m.to);
        if (drop < 6 && last?.to === m.to && lost && lost.color !== me && VAL[m.piece] >= 3) {
          feed += `<p class="muted">That's a sacrifice: you give up your ${NAME[m.piece]} to get something better back. Keep playing to find out what — use Hint if you're stuck.</p>`;
        }
      }
      else feed = verdict + '<p class="muted">The game is over in this line.</p>';
      if (!chess.isGameOver()) await ensureEval();
    } finally {
      busy = false;
      if (alive) { paint(); render(); }
    }
  }

  function tap(sq) {
    if (pending) { pending = null; feed = ''; arrows = []; render(); }
    if (busy || theirTurn() || chess.isGameOver()) return;
    const p = chess.get(sq);
    if (selected && selected !== sq) {
      const legal = chess.moves({ square: selected, verbose: true }).some((m) => m.to === sq);
      if (legal) { play(selected, sq); return; }
    }
    selected = p && p.color === me && selected !== sq ? sq : null;
    arrows = [];
    paint();
  }

  async function act(x) {
    if (x === 'done') { stop(); onExit(); return; }
    if (busy) return;
    if (x === 'again') { pending = null; feed = ''; arrows = []; }
    else if (x === 'anyway' && pending) { const p = pending; pending = null; arrows = []; await play(p.from, p.to, true); return; }
    else if (x === 'undo' && undo.length) {
      const u = undo.pop();
      chess.load(u.fen); e0 = u.e0; feed = u.feed; last = u.last; lastChances = u.lastChances; arrows = []; selected = null;
    } else if (x === 'reset') {
      chess.load(startFen); e0 = null; feed = ''; last = null; arrows = []; selected = null; undo.length = 0; lastChances = null;
      if (theirTurn()) { busy = true; render(); await engineMove(); busy = false; }
    } else if (x === 'hint') {
      busy = true; render();
      const e = await ensureEval();
      busy = false;
      if (e.best) {
        arrows = [{ from: e.best.slice(0, 2), to: e.best.slice(2, 4), color: 'good' }];
        feed = `<p class="verdict good"><b>Hint:</b> ${esc(cap(describeMove(chess.fen(), e.best, 'your')))} (green arrow).</p>` + feed;
      }
    }
    paint(); render();
  }

  function stop() { alive = false; board.onSquare(null); }

  board.onSquare(tap);
  paint(); render();
  if (theirTurn()) {
    busy = true; render();
    engineMove().then(() => ensureEval()).finally(() => { busy = false; if (alive) { paint(); render(); } });
  }
  return { stop };
}
