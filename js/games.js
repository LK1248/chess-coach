// Fetch recent standard-chess games from Chess.com and Lichess (public APIs, no login).
import { Chess } from '../vendor/chess.js';

const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

function speedFromTc(tc) {
  // tc like "180+2" or "1/86400" (daily)
  if (!tc || tc.includes('/')) return 'daily';
  const [base, inc = 0] = tc.split('+').map(Number);
  const est = base + 40 * inc;
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

function clocksFromPgn(pgn) {
  const out = [];
  const re = /%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(pgn))) out.push(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  return out;
}

function normalise({ site, id, url, pgn, white, black, whiteElo, blackElo, result, speed, tc, termination, playedAt, me }) {
  const chess = new Chess();
  try { chess.loadPgn(pgn); } catch { return null; }
  const moves = chess.history();
  if (moves.length < 4) return null;
  const color = white.toLowerCase() === me.toLowerCase() ? 'w' : 'b';
  let outcome = 'draw';
  if (result === '1-0') outcome = color === 'w' ? 'win' : 'loss';
  else if (result === '0-1') outcome = color === 'b' ? 'win' : 'loss';
  const [base, inc = 0] = (tc || '').includes('/') ? [0, 0] : (tc || '0').split('+').map(Number);
  return {
    key: `${site}:${id}`, site, url, moves, clocks: clocksFromPgn(pgn), color,
    me: color === 'w' ? white : black, opponent: color === 'w' ? black : white,
    myElo: color === 'w' ? whiteElo : blackElo, oppElo: color === 'w' ? blackElo : whiteElo,
    outcome, speed, base, inc, termination: termination || '', playedAt,
  };
}

async function fetchChessCom(user, max) {
  const headers = { Accept: 'application/json' };
  const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`, { headers });
  if (!res.ok) throw new Error(`Chess.com: couldn't find "${user}"`);
  const archives = (await res.json()).archives || [];
  const out = [];
  for (let i = archives.length - 1; i >= 0 && out.length < max; i--) {
    const r = await fetch(archives[i], { headers });
    if (!r.ok) continue;
    const games = ((await r.json()).games || []).filter((g) => g.rules === 'chess' && g.pgn);
    for (let j = games.length - 1; j >= 0 && out.length < max; j--) {
      const g = games[j];
      const h = (k) => (g.pgn.match(new RegExp(`\\[${k} "([^"]*)"\\]`)) || [])[1];
      const n = normalise({
        site: 'chesscom', id: g.uuid || g.url, url: g.url, pgn: g.pgn,
        white: g.white.username, black: g.black.username, whiteElo: g.white.rating, blackElo: g.black.rating,
        result: h('Result'), speed: g.time_class || speedFromTc(g.time_control), tc: g.time_control,
        termination: h('Termination'), playedAt: (g.end_time || 0) * 1000, me: user,
      });
      if (n) out.push(n);
    }
  }
  return out;
}

async function fetchLichess(user, max) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&pgnInJson=true&clocks=true&perfType=bullet,blitz,rapid,classical,correspondence`;
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
  if (!res.ok) throw new Error(`Lichess: couldn't find "${user}"`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    if (g.variant !== 'standard' || !g.pgn) continue;
    const tc = g.clock ? `${g.clock.initial}+${g.clock.increment}` : '1/86400';
    const result = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '1/2-1/2';
    const term = { outoftime: 'on time', mate: 'by checkmate', resign: 'by resignation', stalemate: 'stalemate', draw: 'draw' }[g.status] || g.status;
    const n = normalise({
      site: 'lichess', id: g.id, url: `https://lichess.org/${g.id}`, pgn: g.pgn,
      white: g.players.white.user?.name || 'Anonymous', black: g.players.black.user?.name || 'Anonymous',
      whiteElo: g.players.white.rating, blackElo: g.players.black.rating,
      result, speed: g.speed === 'correspondence' ? 'daily' : g.speed, tc, termination: term,
      playedAt: g.lastMoveAt || g.createdAt, me: user,
    });
    if (n) out.push(n);
  }
  return out;
}

/** Returns { games, errors } — newest first. */
export async function fetchRecentGames({ chesscom, lichess }, perSite = 25) {
  const errors = [];
  const jobs = [];
  if (chesscom) jobs.push(fetchChessCom(chesscom, perSite).catch((e) => { errors.push(e.message); return []; }));
  if (lichess) jobs.push(fetchLichess(lichess, perSite).catch((e) => { errors.push(e.message); return []; }));
  const games = (await Promise.all(jobs)).flat().sort((a, b) => b.playedAt - a.playedAt);
  return { games, errors };
}

export { SPEEDS };
