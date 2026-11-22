// AI tutor chat: Claude API (user's own key, stored on this device) + Stockfish tools so every claim is checked.
import Anthropic from '../vendor/anthropic/sdk.js';
import { Chess } from '../vendor/chess.js';
import { evaluate } from './engine.js';
import { describeMove, winChance } from './analyze.js';
import { threatNote, captureNote } from './explore.js';

// USD per million tokens (Anthropic list prices, Nov 2026). Cache writes = 1.25x input (5-minute cache).
export const MODELS = {
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 — recommended', short: 'Sonnet', in: 2, out: 10, cacheRead: 0.10, fallbacks: true },
  'claude-haiku-5-5': { label: 'Haiku 5.5 — cheapest, simpler answers', short: 'Haiku', in: 0.10, out: 0.50, cacheRead: 0.01, fallbacks: false },
  'claude-opus-5-5': { label: 'Opus 5.5 — smartest, about 2x Sonnet', short: 'Opus', in: 4, out: 20, cacheRead: 0.20, fallbacks: true },
};
// Models that can answer if the chosen one declines (server-side fallback) — priced so the meter stays honest.
const OTHER_PRICES = { 'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 }, 'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 } };

export function priceOf(model) { return MODELS[model] || OTHER_PRICES[model] || MODELS['claude-sonnet-5-5']; }

/** Dollar cost of one API response, from its usage block. */
export function costOf(model, usage) {
  const p = priceOf(model);
  const u = usage || {};
  return ((u.input_tokens || 0) * p.in
    + (u.cache_creation_input_tokens || 0) * p.in * 1.25
    + (u.cache_read_input_tokens || 0) * p.cacheRead
    + (u.output_tokens || 0) * p.out) / 1e6;
}

export function fmtMoney(d) {
  if (d < 0.995) return `${(d * 100).toFixed(d * 100 < 10 ? 1 : 0)}¢`;
  return `$${d.toFixed(2)}`;
}

// ---------------- tools the tutor can call ----------------
const uciOk = (u) => typeof u === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u);

export const TOOLS = [
  {
    name: 'evaluate_position',
    description: 'Ask the chess engine about a position. Returns who is better (the student\'s winning chances), the best move and the best line, each described in plain English, plus the moves in UCI so you can use them in other tools. Use this before claiming anything about a position.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['fen'],
      properties: { fen: { type: 'string', description: 'Position in FEN.' } },
    },
  },
  {
    name: 'try_moves',
    description: 'Play a sequence of moves (UCI, e.g. "g1f3", "e7e8q") from a position, then let the engine reply. Returns each move in plain English with what it attacks, whether each was legal, the final position (FEN), the student\'s winning chances there, and the engine\'s best reply. Use this to check "what if" ideas the student asks about.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['fen', 'moves'],
      properties: {
        fen: { type: 'string', description: 'Starting position in FEN.' },
        moves: { type: 'array', items: { type: 'string' }, description: 'Moves in UCI, in order. May be empty.' },
      },
    },
  },
  {
    name: 'show_on_board',
    description: 'Show a position on the student\'s board with arrows, so they can see what you are talking about. Always use this when you refer to specific pieces or moves; the student cannot read chess notation.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['fen', 'arrows'],
      properties: {
        fen: { type: 'string' },
        arrows: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['from', 'to', 'color'],
            properties: {
              from: { type: 'string', description: 'Square like e2' }, to: { type: 'string' },
              color: { type: 'string', enum: ['good', 'bad', 'threat'], description: 'good = green (recommended), bad = red (mistake), threat = orange (opponent idea)' },
            },
          },
        },
      },
    },
  },
];

function lineWords(fen, ucis, viewer, max = 6) {
  const out = [];
  const c = new Chess(fen);
  for (const u of ucis.slice(0, max)) {
    const whose = c.turn() === viewer ? 'you' : 'their';
    const words = describeMove(c.fen(), u, whose);
    try { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    out.push(words);
  }
  return out;
}

async function runTool(name, input, ctx) {
  try {
    if (name === 'show_on_board') {
      new Chess(input.fen); // validates
      ctx.onBoard({ fen: input.fen, arrows: (input.arrows || []).filter((a) => /^[a-h][1-8]$/.test(a.from) && /^[a-h][1-8]$/.test(a.to)) });
      return { shown: true };
    }
    if (name === 'evaluate_position') {
      const c = new Chess(input.fen);
      if (c.isGameOver()) return { game_over: true, checkmate: c.isCheckmate() };
      const e = await evaluate(input.fen, ctx.engineOpts);
      const stmWin = winChance(e);
      return {
        side_to_move: c.turn() === ctx.me ? 'student' : 'opponent',
        student_winning_chances_percent: Math.round(c.turn() === ctx.me ? stmWin : 100 - stmWin),
        mate_in: e.mate ?? null,
        best_move_uci: e.best, best_move_in_words: e.best ? describeMove(input.fen, e.best, c.turn() === ctx.me ? 'you' : 'their') : null,
        best_line_uci: e.pv.slice(0, 6), best_line_in_words: lineWords(input.fen, e.pv, ctx.me),
      };
    }
    if (name === 'try_moves') {
      const c = new Chess(input.fen);
      const steps = [];
      for (const u of input.moves || []) {
        if (!uciOk(u)) return { error: `"${u}" is not a UCI move`, steps };
        const before = c.fen();
        const whose = c.turn() === ctx.me ? 'you' : 'their';
        let m;
        try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return { error: `${u} is illegal in this position`, legal_moves_uci: c.moves({ verbose: true }).map((x) => x.lan), steps }; }
        steps.push({ move: u, in_words: describeMove(before, u, whose), note: [captureNote(before, u, ctx.me), threatNote(c, m.to, ctx.me)].filter(Boolean).join(' ') });
      }
      const result = { steps, final_fen: c.fen() };
      if (c.isGameOver()) return { ...result, game_over: true, checkmate: c.isCheckmate() };
      const e = await evaluate(c.fen(), ctx.engineOpts);
      const stmWin = winChance(e);
      return {
        ...result,
        side_to_move: c.turn() === ctx.me ? 'student' : 'opponent',
        student_winning_chances_percent: Math.round(c.turn() === ctx.me ? stmWin : 100 - stmWin),
        engine_best_next_uci: e.best,
        engine_best_next_in_words: e.best ? describeMove(c.fen(), e.best, c.turn() === ctx.me ? 'you' : 'their') : null,
        engine_line_in_words: lineWords(c.fen(), e.pv, ctx.me),
      };
    }
    return { error: 'unknown tool' };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

// ---------------- prompt ----------------
export const SYSTEM = `You are a friendly, patient chess coach for an adult player rated about 1100-1200 who is stuck at that level.
The student reads your answers on a phone, next to a chessboard.

How to talk:
- Plain English only. Never write chess notation (no "Nf3", "e4", "Qxd5", "O-O") and never name squares ("e5", "f7"). Refer to pieces by what they are and where they are in everyday words ("your knight in the middle", "their bishop aimed at your king"), and use show_on_board with arrows so the student can see it.
- Keep answers short: 2-5 sentences, like a coach at the board. One idea at a time. End with a question or a small thing to try when it helps.
- Connect the answer to a habit they can use in their own games (check what the opponent's last move attacks; look for checks, captures and threats; ask "can this piece be taken?" before moving).
- If the student is wrong, say so kindly and show why. If they are right, say so.

How to be correct:
- You are not reliable at calculating chess moves in your head. Before saying a move wins, loses, hangs a piece, or is better, check it with evaluate_position or try_moves. Only state what the tools confirm. If the tools disagree with your idea, trust the tools.
- Moves in tools are UCI (from-square + to-square, e.g. g1f3). That is for tools only; never show it to the student.
- Talk about winning chances as a percentage only if it helps; avoid engine jargon like "centipawns" or "+1.5".`;

export function contextText({ game, ply, fen, moment, me }) {
  const lines = [
    'Context from the app (the student does not see this block):',
    `Student plays ${me === 'w' ? 'White' : 'Black'} against ${game.opponent} (${game.oppElo || 'unrated'}), ${game.speed} game, move ${Math.floor(ply / 2) + 1}.`,
    `Current position (FEN): ${fen}`,
  ];
  if (moment) {
    lines.push(
      `At this position the student played ${moment.myUci} (${describeMove(fen, moment.myUci, 'you')}). The review flagged it as a ${moment.severity === 'blunder' ? 'big mistake' : 'mistake'}: winning chances went from ${moment.before}% to ${moment.after}%.`,
      `The app's explanation shown to the student: "${moment.text}"`,
      moment.bestUci ? `Engine's better move: ${moment.bestUci}. Better line (UCI): ${moment.betterLine.join(' ')}` : '',
      `What happens after the student's move (UCI, starting with the student's move): ${[moment.myUci, ...moment.punishLine].join(' ')}`,
    );
  }
  return lines.filter(Boolean).join('\n');
}

// ---------------- conversation ----------------
export class TutorError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err instanceof Anthropic.AuthenticationError) return new TutorError('key', 'Your API key was rejected. Check it in Settings — it should start with "sk-ant-".');
  if (err instanceof Anthropic.PermissionDeniedError) return new TutorError('key', 'This API key isn\'t allowed to use that model. Try another model in Settings.');
  if (/credit balance/i.test(msg)) return new TutorError('credits', 'Your Anthropic credit balance has run out, so the tutor can\'t answer. Add credits at platform.claude.com → Billing.');
  if (/spend limit|enforced_spend_limit/i.test(msg)) return new TutorError('limit', 'Your monthly spend limit in the Anthropic Console has been reached. The tutor will work again next month, or after you raise the limit.');
  if (err instanceof Anthropic.RateLimitError) return new TutorError('rate', 'Too many questions in a short time. Wait a minute and try again.');
  if (err instanceof Anthropic.APIConnectionError) return new TutorError('net', 'Couldn\'t reach Anthropic. Check your internet connection.');
  if (err instanceof Anthropic.InternalServerError) return new TutorError('server', 'Anthropic\'s service had a hiccup. Try again in a moment.');
  return new TutorError('other', `Something went wrong: ${msg.slice(0, 200)}`);
}

/**
 * One student turn: sends the question, runs tool calls until Claude answers.
 * history: API message array (mutated: assistant + tool turns appended).
 * Returns { text, cost, requests } — cost in USD for this turn.
 */
export async function ask({ apiKey, model, history, question, context, ctx, onCost, fetchImpl }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  history.push({ role: 'user', content: context ? [{ type: 'text', text: context }, { type: 'text', text: question }] : question });
  let cost = 0;
  for (let round = 0; round < 8; round++) {
    let res;
    try {
      res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages: history,
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        ...(MODELS[model]?.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      });
    } catch (err) {
      if (round === 0) history.pop(); // keep history clean so the question can be asked again
      throw friendlyError(err);
    }
    const c = costOf(res.model || model, res.usage);
    cost += c;
    onCost?.(c, res.model || model, res.usage);
    history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'refusal') return { text: 'Sorry — I can\'t answer that one. Try asking it a different way.', cost };
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text: text || '(No answer — try asking again.)', cost };
    }
    const results = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      const out = await runTool(b.name, b.input || {}, ctx);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    history.push({ role: 'user', content: results });
  }
  return { text: 'That took too many steps — try a simpler question.', cost };
}
