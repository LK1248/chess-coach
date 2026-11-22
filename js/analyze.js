// Turns engine evaluations into "key moments" explained in plain English.
import { Chess } from '../vendor/chess.js';
import { evaluate } from './engine.js';

export const ANALYSIS_VERSION = 3;
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const opp = (c) => (c === 'w' ? 'b' : 'w');

// Win chance (0..100) for the side to move, the same curve Lichess uses.
export function winChance(e) {
  if (e.mate !== null && e.mate !== undefined) return e.mate > 0 ? 100 : 0;
  const cp = Math.max(-1500, Math.min(1500, e.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function positionsOf(game) {
  const c = new Chess();
  const fens = [c.fen()];
  const verbose = [];
  for (const san of game.moves) { verbose.push(c.move(san)); fens.push(c.fen()); }
  return { fens, verbose };
}

// ---------- helpers on boards ----------
function balance(chess, me) {
  let s = 0;
  for (const row of chess.board()) for (const sq of row) if (sq) s += (sq.color === me ? 1 : -1) * VAL[sq.type];
  return s;
}
function nonPawnMaterial(chess) {
  let s = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.type !== 'p') s += VAL[sq.type];
  return s;
}
const uciObj = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
function play(fen, ucis, max = 8, me = null) {
  const c = new Chess(fen);
  const moves = [], bals = [];
  for (const u of ucis.slice(0, max)) {
    try { moves.push(c.move(uciObj(u))); } catch { break; }
    if (me) bals.push(balance(c, me));
  }
  return { chess: c, moves, bals };
}
function attackedTargets(chess, sq, attackerColor) {
  // pieces of the other side attacked by the piece now standing on `sq`
  const victims = [];
  for (const row of chess.board()) for (const p of row) {
    if (!p || p.color === attackerColor) continue;
    if (chess.attackers(p.square, attackerColor).includes(sq)) victims.push(p);
  }
  return victims;
}

/**
 * Plain-English description of a move.
 * whose = 'your' → "take their rook with your bishop" (advice), 'you' → "you take their rook with your bishop",
 * 'their' → "their bishop takes your rook".
 */
export function describeMove(fen, uci, whose = 'your') {
  const c = new Chess(fen);
  let m;
  try { m = c.move(uciObj(uci)); } catch { return 'a different move'; }
  const castle = m.isKingsideCastle() || m.isQueensideCastle();
  let s;
  if (whose === 'their') {
    if (castle) s = 'they castle';
    else if (m.captured) s = `their ${NAME[m.piece]} takes your ${NAME[m.captured]}`;
    else s = `their ${NAME[m.piece]} moves`;
    if (m.promotion) s += ` and becomes a ${NAME[m.promotion]}`;
  } else {
    const pre = whose === 'you' ? 'you ' : '';
    if (castle) s = `${pre}castle (tuck your king away)`;
    else if (m.captured) s = `${pre}take their ${NAME[m.captured]} with your ${NAME[m.piece]}`;
    else s = `${pre}move your ${NAME[m.piece]}`;
    if (m.promotion) s += ` and turn it into a ${NAME[m.promotion]}`;
  }
  if (c.isCheckmate()) s += ' — checkmate';
  else if (c.inCheck()) s += ', giving check';
  return s;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function pairNames(a, b) { return a === b ? `both your ${a}s` : `your ${a} and your ${b}`; }

export const CATEGORIES = {
  hung_piece: {
    label: 'Moved a piece where it could be taken',
    habit: 'Before you let go of a piece, look at its new square and ask: "Can it be taken? Who attacks it, and who defends it?"',
  },
  ignored_threat: {
    label: 'Missed what their last move was attacking',
    habit: 'After every move your opponent makes, stop and ask: "What does that move attack? What is it threatening next?"',
  },
  left_unprotected: {
    label: 'Moved a defender away',
    habit: 'When you move a piece, check what it was protecting. Its old job doesn\'t go away when it leaves.',
  },
  allowed_fork: {
    label: 'Allowed a double attack (fork)',
    habit: 'Watch for squares where one enemy piece — very often a knight — could attack two of your pieces at once.',
  },
  allowed_tactic: {
    label: 'Walked into a trick',
    habit: 'Before each move, look at every check your opponent could give in reply, and what it would attack.',
  },
  allowed_mate: {
    label: 'Allowed checkmate',
    habit: 'Before each move, look at every check your opponent could give. Make sure your king has an escape square.',
  },
  missed_mate: {
    label: 'Missed a checkmate',
    habit: 'Every move, look at every check YOU can give first — checks are the most forcing moves.',
  },
  missed_win: {
    label: 'Missed a chance to win material',
    habit: 'Every move, scan for "free stuff": is any of their pieces attacked and not defended? Can you attack two things at once?',
  },
  positional: {
    label: 'Weakened the position',
    habit: 'When nothing is hanging, improve your worst piece, keep your king safe, and avoid moves that leave holes.',
  },
};

// ---------- moment explanation ----------
export function explain({ fen0, san, e0, e1, me, clockLeft, base, ply }) {
  const them = opp(me);
  const c0 = new Chess(fen0);
  const m = new Chess(fen0).move(san);
  const myUci = m.from + m.to + (m.promotion || '');
  const fen1 = (() => { const c = new Chess(fen0); c.move(san); return c.fen(); })();
  const startBal = balance(c0, me);
  const played = play(fen0, [myUci, ...(e1.pv || [])], 9, me);
  const best = play(fen0, e0.pv || [], 8);
  const swingPlayed = balance(played.chess, me) - startBal;
  const swingBest = balance(best.chess, me) - startBal;
  const materialLost = Math.max(0, swingBest - swingPlayed);

  const arrows = [{ from: m.from, to: m.to, color: 'bad' }];
  if (e0.best && e0.best !== myUci) arrows.push({ from: e0.best.slice(0, 2), to: e0.best.slice(2, 4), color: 'good' });
  const highlights = [];
  const betterText = e0.best && e0.best !== myUci ? describeMove(fen0, e0.best, 'your') : null;
  const reply = e1.pv?.[0];
  const replyText = reply ? describeMove(fen1, reply, 'their') : null;

  let category = 'positional';
  let text = '';

  const userStillMates = e1.mate !== null && e1.mate < 0;
  if (e0.mate !== null && e0.mate > 0 && !userStillMates) {
    category = 'missed_mate';
    text = `You had a checkmate here${e0.mate > 1 ? ` in ${e0.mate} moves` : ''}! The first move was to ${betterText}.`;
  } else if (e1.mate !== null && e1.mate > 0 && !(e0.mate !== null && e0.mate < 0)) {
    category = 'allowed_mate';
    text = `This move let your opponent checkmate you${e1.mate > 1 ? ` in ${e1.mate} moves` : ''}. They could answer: ${replyText}.`;
    const reCap = reply ? reply.slice(2, 4) : null;
    if (reCap) highlights.push({ sq: reCap, color: 'bad' });
  } else {
    // Follow the expected line after my move and find the capture where I actually come out behind.
    let lossIdx = -1;
    const finalBal = played.bals[played.bals.length - 1] ?? startBal;
    if (finalBal <= startBal - 2) {
      for (let j = 1; j < played.moves.length; j += 2) {
        if (played.moves[j].captured && played.bals[j] <= startBal - 2) { lossIdx = j; break; }
      }
      if (lossIdx === -1) for (let j = 1; j < played.moves.length; j += 2) if (played.moves[j].captured) { lossIdx = j; break; }
    }
    if (lossIdx > 0) {
      const cap = played.moves[lossIdx];
      const victim = NAME[cap.captured];
      const net = Math.round(startBal - finalBal);
      if (lossIdx === 1) {
        highlights.push({ sq: cap.to, color: 'bad' });
        arrows.push({ from: cap.from, to: cap.to, color: 'threat' });
        if (cap.to === m.to) {
          category = 'hung_piece';
          text = m.captured
            ? `You took their ${NAME[m.captured]}, but then their ${NAME[cap.piece]} takes your ${NAME[m.piece]} — you give more than you get.`
            : `You moved your ${NAME[m.piece]} to a square where their ${NAME[cap.piece]} can take it.`;
          const def = new Chess(fen1).attackers(m.to, me).length;
          if (!m.captured) text += def && VAL[cap.piece] < VAL[m.piece] ? ` It was protected, but a ${NAME[cap.piece]} is worth less than your ${NAME[m.piece]}, so the trade still loses.` : def ? '' : ' Nothing was protecting it there.';
        } else if (c0.isAttacked(cap.to, them) && c0.get(cap.to)?.color === me) {
          category = 'ignored_threat';
          text = `Your ${victim} was already under attack before this move, and your move didn't save it. Their ${NAME[cap.piece]} can now take it.`;
        } else if (c0.attackers(cap.to, me).includes(m.from)) {
          category = 'left_unprotected';
          text = `Your ${NAME[m.piece]} was protecting your ${victim}. When it moved away, the ${victim} was left unprotected, and their ${NAME[cap.piece]} can take it.`;
        } else {
          category = 'left_unprotected';
          text = `After your move, their ${NAME[cap.piece]} can take your ${victim} — your move opened the way to it or took away its protection.`;
        }
      } else {
        const first = played.moves[1];
        const fb = new Chess(fen1); fb.move(first);
        const targets = attackedTargets(fb, first.to, them).filter((p) => p.type === 'k' || VAL[p.type] >= 3);
        arrows.push({ from: first.from, to: first.to, color: 'threat' });
        if (targets.length >= 2) {
          category = 'allowed_fork';
          const names = targets.slice(0, 2).map((p) => NAME[p.type]);
          text = `Your move allowed a double attack: their ${NAME[first.piece]} can attack ${pairNames(names[0], names[1])} at the same time. You can only save one, so you lose your ${victim}.`;
        } else if (fb.inCheck()) {
          category = 'allowed_tactic';
          text = `Your move allowed a strong check (${replyText}). After you deal with the check, you lose your ${victim}.`;
        } else if (targets.length === 1 || VAL[cap.captured] >= 3) {
          category = 'allowed_tactic';
          text = `After your move, they have a strong answer (${replyText}). You can't hold everything together, and a few moves later you lose your ${victim}.`;
        } else {
          category = 'positional';
          text = `This move lets them win a pawn a few moves later. It starts with: ${replyText}.`;
        }
      }
      if (net >= 1 && category !== 'positional') text += ` You end up about ${plural(net, 'point')} of material behind.`;
    } else if (materialLost >= 2 && e0.best) {
      category = 'missed_win';
      const bm = best.moves[0];
      if (bm?.captured) {
        text = `Their ${NAME[bm.captured]} could be won here: ${betterText}.`;
        highlights.push({ sq: bm.to, color: 'good' });
      } else {
        text = `There was a move that wins material: ${betterText}.`;
        if (bm) {
          const b = new Chess(fen0); b.move(bm);
          const t = attackedTargets(b, bm.to, me).filter((p) => p.type === 'k' || VAL[p.type] >= 3);
          if (t.length >= 2) text += ` It attacks ${pairNames(NAME[t[0].type], NAME[t[1].type]).replace(/your/g, 'their')} at the same time.`;
        }
      }
    } else {
      category = 'positional';
      const bm = best.moves[0];
      if (bm && bm.san.includes('+')) text = `You missed a strong attacking move: ${betterText}. Your move gave your opponent time to defend.`;
      else text = `No piece is lost right away, but this move made your position a lot worse.${betterText ? ` A better idea was to ${betterText} (green arrow).` : ''}`;
    }
  }
  if (betterText && !['missed_mate', 'missed_win', 'positional'].includes(category)) text += ` Better was to ${betterText} (green arrow).`;
  if (category === 'missed_win' && materialLost >= 1) text += ` That would have won about ${Math.round(materialLost)} point${Math.round(materialLost) === 1 ? '' : 's'} of material.`;
  const lowTime = base > 0 && clockLeft !== null && clockLeft !== undefined && clockLeft < Math.max(10, base * 0.1);
  if (lowTime) text += ` You had only ${plural(Math.round(clockLeft), 'second')} left here.`;

  const phase = ply < 20 ? 'opening' : nonPawnMaterial(c0) <= 26 ? 'endgame' : 'middlegame';
  return {
    ply, category, text, arrows, highlights, lowTime, phase,
    myUci, bestUci: e0.best, punishLine: e1.pv?.slice(0, 8) || [], betterLine: e0.pv?.slice(0, 8) || [],
  };
}

/**
 * Analyze one game. Returns { v, wins:[white win% per position], moments:[...], summary }.
 * onProgress(done, total) is called after each position.
 */
export async function analyzeGame(game, onProgress = () => {}, opts = {}) {
  const { fens } = positionsOf(game);
  const me = game.color;
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    const c = new Chess(fens[i]);
    if (c.isCheckmate()) evals.push({ cp: null, mate: 0, best: null, pv: [], wc: 0 });
    else if (c.isDraw() || c.isStalemate()) evals.push({ cp: 0, mate: null, best: null, pv: [], wc: 50 });
    else {
      const e = await evaluate(fens[i], opts);
      evals.push({ ...e, wc: winChance(e) });
    }
    onProgress(i + 1, fens.length);
  }
  const stm = (i) => (i % 2 === 0 ? 'w' : 'b');
  const myWin = (i) => (stm(i) === me ? evals[i].wc : 100 - evals[i].wc);
  const wins = evals.map((e, i) => Math.round(stm(i) === 'w' ? e.wc : 100 - e.wc));

  const moments = [];
  const firstMine = me === 'w' ? 0 : 1;
  for (let i = firstMine; i < game.moves.length; i += 2) {
    const before = myWin(i), after = myWin(i + 1);
    const drop = before - after;
    if (drop < 10) continue;
    if (before > 97 && after > 90) continue; // still totally winning
    if (before < 3) continue; // already lost
    const m = explain({
      fen0: fens[i], san: game.moves[i], e0: evals[i], e1: evals[i + 1], me,
      clockLeft: game.clocks[i] ?? null, base: game.base, ply: i,
    });
    moments.push({ ...m, severity: drop >= 20 ? 'blunder' : 'mistake', before: Math.round(before), after: Math.round(after) });
  }
  const mine = [];
  for (let i = firstMine; i < game.moves.length; i += 2) mine.push(myWin(i));
  const best = Math.max(...mine.slice(3), 0);
  return {
    v: ANALYSIS_VERSION,
    wins,
    best: evals.map((e) => e.best),
    moments,
    summary: { peak: Math.round(best), threwWin: game.outcome !== 'win' && best >= 80 },
  };
}
