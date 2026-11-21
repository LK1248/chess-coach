import { store, DEPTHS } from './store.js';
import { fetchRecentGames } from './games.js';
import { analyzeGame, positionsOf, CATEGORIES, ANALYSIS_VERSION, describeMove, NAME } from './analyze.js';
import { createBoard } from './board.js';
import { Chess } from '../vendor/chess.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moveNo = (ply) => Math.floor(ply / 2) + 1;
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const SPEED_LABEL = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', daily: 'Daily' };
const SITE_LABEL = { chesscom: 'Chess.com', lichess: 'Lichess' };
let stopAnim = () => {};

// ---------------- install (PWA) ----------------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; updateInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; updateInstall(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function updateInstall() {
  const b = document.getElementById('install');
  if (b) b.hidden = !(installPrompt || (isIOS() && !isStandalone()));
}
async function doInstall() {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; updateInstall(); }
  else if (isIOS()) alert('To install: tap the Share button in Safari, then "Add to Home Screen".');
}

// ---------------- background analysis ----------------
const runner = { running: false, paused: false, key: null, done: 0, total: 0 };
function pendingGames() {
  const a = store.analyses();
  return store.games().filter((g) => !a[g.key] || a[g.key].v !== ANALYSIS_VERSION);
}
async function runQueue() {
  if (runner.running) return;
  runner.running = true;
  while (!runner.paused) {
    const next = pendingGames()[0];
    if (!next) break;
    Object.assign(runner, { key: next.key, done: 0, total: next.moves.length + 1 });
    showStatus();
    let a;
    try {
      a = await analyzeGame(next, (d, t) => { runner.done = d; runner.total = t; showStatus(); }, DEPTHS[store.settings().depth]);
    } catch (e) {
      console.error(e);
      a = { v: ANALYSIS_VERSION, error: String(e), wins: [], moments: [], summary: {} };
    }
    store.saveAnalysis(next.key, a);
    runner.key = null;
    onAnalysisSaved(next.key);
  }
  runner.running = false;
  showStatus();
}
function showStatus() {
  const s = document.getElementById('status');
  if (!s) return;
  const left = pendingGames().length;
  if (!left) { s.hidden = true; return; }
  s.hidden = false;
  const pct = runner.total ? Math.round((runner.done / runner.total) * 100) : 0;
  s.innerHTML = runner.paused || !runner.running
    ? `<span>${left} game${left > 1 ? 's' : ''} waiting for review</span><button class="link" data-act="resume">Review now</button>`
    : `<span>Reviewing your games… ${left} left</span><div class="bar"><i style="width:${pct}%"></i></div><button class="link" data-act="pause">Pause</button>`;
}
function onAnalysisSaved(key) {
  const r = route();
  if (r.name === 'home' || r.name === 'report') render({ keepScroll: true });
  else if (r.name === 'game' && r.key === key) render({ keepScroll: true });
  else showStatus();
}

// ---------------- routing ----------------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'game') return { name: 'game', key: parts[1], ply: parts[2] !== undefined && parts[2] !== '' ? +parts[2] : null };
  if (parts[0] === 'report') return { name: 'report' };
  if (parts[0] === 'pattern') return { name: 'pattern', cat: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };
let navDepth = 0;
let lastPath = location.hash;
window.addEventListener('hashchange', () => {
  // count in-app navigations so Back can use browser history
  navDepth = Math.max(0, navDepth + (history.state?.back ? -1 : 1));
  render();
});

function render({ keepScroll = false } = {}) {
  stopAnim();
  const y = scrollY;
  const r = route();
  if (r.name === 'game') viewGame(r);
  else if (r.name === 'report') viewReport();
  else if (r.name === 'pattern') viewPattern(r.cat);
  else if (r.name === 'settings') viewSettings();
  else viewHome();
  updateInstall();
  showStatus();
  scrollTo(0, keepScroll ? y : 0);
}

function topbar(title, { back = null, actions = '' } = {}) {
  return `<header class="top">
    ${back ? `<button class="icon" data-act="back" data-to="${back}" aria-label="Back">‹</button>` : '<span class="logo">♞</span>'}
    <h1>${esc(title)}</h1>
    <button id="install" class="pill" data-act="install" hidden>Install</button>
    ${actions}
  </header><div id="status" class="status" hidden></div>`;
}

// ---------------- home ----------------
let filter = 'all';
let fetching = false;
async function refreshGames() {
  if (fetching) return;
  if (!store.settings().chesscom && !store.settings().lichess) { go('#/settings'); return; }
  fetching = true; render({ keepScroll: true });
  const s = store.settings();
  const { games, errors } = await fetchRecentGames({ chesscom: s.chesscom, lichess: s.lichess }, s.perSite);
  store.mergeGames(games);
  fetching = false;
  lastFetchErrors = errors;
  render({ keepScroll: true });
  if (s.autoAnalyze && !runner.paused) runQueue();
}
let lastFetchErrors = [];

function gameRow(g, a) {
  const res = { win: ['W', 'win'], loss: ['L', 'loss'], draw: ['½', 'draw'] }[g.outcome];
  let right;
  if (!a || a.v !== ANALYSIS_VERSION) right = runner.key === g.key ? `<span class="muted">${Math.round((runner.done / (runner.total || 1)) * 100)}%</span>` : '<span class="muted">waiting</span>';
  else if (a.error) right = '<span class="muted">couldn\'t review</span>';
  else {
    const big = a.moments.filter((m) => m.severity === 'blunder').length;
    right = big ? `<span class="tag bad">${big} big mistake${big > 1 ? 's' : ''}</span>` : a.moments.length ? `<span class="tag warn">${a.moments.length} mistake${a.moments.length > 1 ? 's' : ''}</span>` : '<span class="tag good">clean</span>';
  }
  return `<a class="row" href="#/game/${encodeURIComponent(g.key)}">
    <span class="res ${res[1]}">${res[0]}</span>
    <span class="grow"><b>vs ${esc(g.opponent)}</b>${g.oppElo ? ` <span class="muted">(${g.oppElo})</span>` : ''}<br>
    <small class="muted">${SPEED_LABEL[g.speed] || g.speed} · ${SITE_LABEL[g.site]} · ${fmtDate(g.playedAt)}</small></span>
    ${right}</a>`;
}

function viewHome() {
  const games = store.games();
  const analyses = store.analyses();
  const reviewed = games.filter((g) => analyses[g.key]?.v === ANALYSIS_VERSION && !analyses[g.key].error).length;
  const speeds = [...new Set(games.map((g) => g.speed))];
  const shown = filter === 'all' ? games : games.filter((g) => g.speed === filter);
  app.innerHTML = `${topbar('Chess Coach', { actions: '<a class="icon" href="#/settings" aria-label="Settings">⚙</a>' })}
  <main>
    ${!games.length ? `<section class="card hero">
        <h2>Let's look at your games</h2>
        <p>I'll download your recent games from Chess.com and Lichess, find the moments where things went wrong, and explain them in plain English.</p>
        <button class="primary" data-act="fetch" ${fetching ? 'disabled' : ''}>${fetching ? 'Getting your games…' : 'Get my games'}</button>
      </section>` : `
      <a class="card cta" href="#/report">
        <div><h2>Your patterns</h2><p class="muted">${reviewed ? `Based on ${reviewed} reviewed game${reviewed > 1 ? 's' : ''}` : 'Ready after the first game is reviewed'}</p></div><span class="chev">›</span>
      </a>
      <div class="toolbar">
        <div class="chips">
          ${['all', ...speeds].map((sp) => `<button class="chip ${filter === sp ? 'on' : ''}" data-filter="${sp}">${sp === 'all' ? 'All' : SPEED_LABEL[sp] || sp}</button>`).join('')}
        </div>
        <button class="pill" data-act="fetch" ${fetching ? 'disabled' : ''}>${fetching ? 'Loading…' : '↻ New games'}</button>
      </div>`}
    ${lastFetchErrors.map((e) => `<p class="error">${esc(e)}</p>`).join('')}
    <div class="list">${shown.map((g) => gameRow(g, analyses[g.key])).join('')}</div>
  </main>`;
}

// ---------------- game review ----------------
function evalGraph(wins, color, moments, ply) {
  if (!wins?.length) return '';
  const n = wins.length - 1 || 1;
  const pts = wins.map((w, i) => `${(i / n) * 100},${100 - (color === 'w' ? w : 100 - w)}`).join(' ');
  const dots = moments.map((m) => `<circle cx="${((m.ply + 1) / n) * 100}" cy="${100 - (color === 'w' ? wins[m.ply + 1] : 100 - wins[m.ply + 1])}" r="3.2" class="${m.severity}"/>`).join('');
  return `<svg class="graph" viewBox="0 0 100 100" preserveAspectRatio="none" data-n="${n}">
    <polygon points="0,100 ${pts} 100,100" class="area"/><line x1="0" y1="50" x2="100" y2="50" class="mid"/>
    <line x1="${(ply / n) * 100}" x2="${(ply / n) * 100}" y1="0" y2="100" class="cursor"/>${dots}</svg>`;
}

function viewGame(r) {
  const g = store.game(r.key);
  if (!g) { go('#/'); return; }
  const a = store.analysis(g.key);
  const ready = a && a.v === ANALYSIS_VERSION && !a.error;
  const { fens, verbose } = positionsOf(g);
  const moments = ready ? a.moments : [];
  let ply = r.ply ?? (moments[0]?.ply ?? 0);
  ply = Math.max(0, Math.min(fens.length - 1, ply));
  const moment = moments.find((m) => m.ply === ply);
  const flip = g.color === 'b';
  const res = { win: 'You won', loss: 'You lost', draw: 'Draw' }[g.outcome];

  let panel;
  if (!ready) {
    panel = `<section class="card"><p>${a?.error ? 'This game couldn\'t be reviewed.' : runner.key === g.key ? `Reviewing this game… ${Math.round((runner.done / (runner.total || 1)) * 100)}%` : 'This game is waiting for review.'}</p>
      ${!a?.error && runner.key !== g.key ? '<button class="primary" data-act="analyze-now">Review it now</button>' : ''}</section>`;
  } else if (moment) {
    const cat = CATEGORIES[moment.category];
    panel = `<section class="card moment">
      <div class="mhead"><span class="tag ${moment.severity === 'blunder' ? 'bad' : 'warn'}">${moment.severity === 'blunder' ? 'Big mistake' : 'Mistake'}</span>
      <small class="muted">Move ${moveNo(ply)} · your winning chances ${moment.before}% → ${moment.after}%</small></div>
      <h3>${esc(cat.label)}</h3>
      <p>${esc(moment.text)}</p>
      <div class="legend"><span><i class="sw bad"></i>your move</span>${moment.bestUci && moment.bestUci !== moment.myUci ? '<span><i class="sw good"></i>better move</span>' : ''}${moment.arrows.some((x) => x.color === 'threat') ? '<span><i class="sw threat"></i>their answer</span>' : ''}</div>
      <div class="habit"><b>Habit to build</b><p>${esc(cat.habit)}</p></div>
      <div class="btns"><button class="pill" data-act="line-punish">▶ What happens next</button>${moment.betterLine.length ? '<button class="pill" data-act="line-better">▶ The better move</button>' : ''}</div>
      <p id="caption" class="caption" hidden></p>
    </section>`;
  } else {
    const last = verbose[ply - 1];
    const who = last ? ((ply - 1) % 2 === 0 ? 'w' : 'b') === g.color ? 'you' : 'their' : null;
    panel = `<section class="card"><p>${last ? `Move ${moveNo(ply - 1)}: ${esc(describeMove(fens[ply - 1], last.from + last.to + (last.promotion || ''), who))}.` : 'Starting position.'}</p>
      ${ply === fens.length - 1 ? `<p class="muted">${res}${g.termination ? ` — ${esc(g.termination.replace(/^.* won /, ''))}` : ''}.</p>` : ''}
      ${moments.length ? '' : '<p class="muted">No big mistakes found in this game. Nice!</p>'}</section>`;
  }

  app.innerHTML = `${topbar(`vs ${g.opponent}`, { back: '#/' })}
  <main class="review">
    <div id="board" class="boardwrap"></div>
    ${ready ? evalGraph(a.wins, g.color, moments, ply) : ''}
    <div class="nav">
      <button data-ply="0" aria-label="Start">⏮</button>
      <button data-ply="${Math.max(0, ply - 1)}" aria-label="Back">◀</button>
      <span class="muted">${moment ? `Move ${moveNo(ply)}` : ply === 0 ? 'Start' : `Move ${moveNo(ply - 1)}`} · ${res}</span>
      <button data-ply="${Math.min(fens.length - 1, ply + 1)}" aria-label="Forward">▶</button>
      <button data-ply="${fens.length - 1}" aria-label="End">⏭</button>
    </div>
    ${panel}
    ${moments.length ? `<h4 class="sub">Key moments in this game</h4><div class="chips wrap">${moments.map((m) =>
      `<button class="chip ${m.ply === ply ? 'on' : ''} ${m.severity}" data-ply="${m.ply}">Move ${moveNo(m.ply)}</button>`).join('')}</div>` : ''}
    <p class="foot"><a href="${esc(g.url)}" target="_blank" rel="noopener">Open on ${SITE_LABEL[g.site]}</a></p>
  </main>`;

  const board = createBoard(document.getElementById('board'));
  const lastOf = (p) => (verbose[p - 1] ? { from: verbose[p - 1].from, to: verbose[p - 1].to } : null);
  const showMoment = () => board.draw(moment
    ? { fen: fens[ply], flip, arrows: moment.arrows, highlights: moment.highlights, last: lastOf(ply) }
    : { fen: fens[ply], flip, last: lastOf(ply) });
  showMoment();

  const setPly = (p) => history.replaceState(null, '', `#/game/${encodeURIComponent(g.key)}/${p}`) || render();
  app.querySelectorAll('[data-ply]').forEach((b) => b.addEventListener('click', () => setPly(+b.dataset.ply)));
  const graph = app.querySelector('.graph');
  if (graph) graph.addEventListener('click', (e) => {
    const rect = graph.getBoundingClientRect();
    setPly(Math.round(((e.clientX - rect.left) / rect.width) * +graph.dataset.n));
  });
  // swipe left/right on the board to step through moves
  let sx = null;
  const bw = document.getElementById('board');
  bw.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  bw.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 40) setPly(Math.max(0, Math.min(fens.length - 1, ply + (dx < 0 ? 1 : -1))));
  });

  if (moment) {
    const play = (ucis, firstWhose) => {
      stopAnim();
      const cap = document.getElementById('caption');
      const seq = [];
      let fen = fens[ply];
      ucis.forEach((u, i) => {
        const whose = i % 2 === 0 ? 'you' : 'their';
        const text = describeMove(fen, u, whose);
        const c = new Chess(fen);
        c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        fen = c.fen();
        seq.push({ fen, last: { from: u.slice(0, 2), to: u.slice(2, 4) }, text });
      });
      let i = 0, timer = null;
      const step = () => {
        if (i >= seq.length) { cap.innerHTML += ' <button class="link" data-act="replay">Back to the moment</button>'; return; }
        const s = seq[i];
        board.draw({ fen: s.fen, flip, last: s.last });
        cap.hidden = false;
        cap.textContent = `${i + 1}. ${s.text.charAt(0).toUpperCase() + s.text.slice(1)}`;
        i++;
        timer = setTimeout(step, 1400);
      };
      stopAnim = () => clearTimeout(timer);
      step();
    };
    app.querySelector('[data-act="line-punish"]').onclick = () => play([moment.myUci, ...moment.punishLine.slice(0, 5)], 'your');
    const lb = app.querySelector('[data-act="line-better"]');
    if (lb) lb.onclick = () => play(moment.betterLine.slice(0, 5), 'your');
  }
}

// ---------------- report ----------------
function collect() {
  const games = store.games();
  const analyses = store.analyses();
  const reviewed = games.filter((g) => analyses[g.key]?.v === ANALYSIS_VERSION && !analyses[g.key].error);
  const moments = reviewed.flatMap((g) => analyses[g.key].moments.map((m) => ({ ...m, game: g })));
  return { games, analyses, reviewed, moments };
}

function viewReport() {
  const { games, analyses, reviewed, moments } = collect();
  const n = reviewed.length;
  if (!n) {
    app.innerHTML = `${topbar('Your patterns', { back: '#/' })}<main><section class="card"><p>Your report appears here once at least one game has been reviewed. ${pendingGames().length ? 'Reviewing is in progress — check back in a minute.' : 'Get your games from the home screen first.'}</p></section></main>`;
    return;
  }
  const byCat = {};
  for (const m of moments) {
    const c = (byCat[m.category] ||= { count: 0, big: 0 });
    c.count++; if (m.severity === 'blunder') c.big++;
  }
  const cats = Object.entries(byCat).sort((a, b) => (b[1].big * 2 + b[1].count) - (a[1].big * 2 + a[1].count));
  const top = cats.find(([k]) => k !== 'positional') || cats[0];
  const max = Math.max(...cats.map(([, v]) => v.count), 1);
  const big = moments.filter((m) => m.severity === 'blunder').length;
  const low = moments.filter((m) => m.lowTime).length;
  const phases = { opening: 0, middlegame: 0, endgame: 0 };
  moments.forEach((m) => phases[m.phase]++);
  const threw = reviewed.filter((g) => analyses[g.key].summary?.threwWin).length;
  const timeLosses = games.filter((g) => g.outcome === 'loss' && /time/i.test(g.termination)).length;
  const losses = games.filter((g) => g.outcome === 'loss').length;

  const bySpeed = {};
  for (const g of games) {
    const s = (bySpeed[g.speed] ||= { n: 0, w: 0 });
    s.n++; if (g.outcome === 'win') s.w++;
  }
  const bulletShare = (bySpeed.bullet?.n || 0) / (games.length || 1);
  const pct = (x, t) => Math.round((x / (t || 1)) * 100);

  app.innerHTML = `${topbar('Your patterns', { back: '#/' })}
  <main>
    <section class="stats">
      <div><b>${n}</b><small>games reviewed</small></div>
      <div><b>${(big / n).toFixed(1)}</b><small>big mistakes per game</small></div>
      <div><b>${(moments.length / n).toFixed(1)}</b><small>mistakes per game</small></div>
    </section>

    ${top ? `<section class="card focus">
      <small class="muted">THE #1 THING TO WORK ON</small>
      <h2>${esc(CATEGORIES[top[0]].label)}</h2>
      <p>This happened ${top[1].count} time${top[1].count > 1 ? 's' : ''} in ${n} game${n > 1 ? 's' : ''}${top[1].big ? `, and ${top[1].big} of those were big mistakes` : ''}.</p>
      <div class="habit"><b>Habit to build</b><p>${esc(CATEGORIES[top[0]].habit)}</p></div>
      <a class="pill" href="#/pattern/${top[0]}">See your examples ›</a>
    </section>` : ''}

    <h4 class="sub">All mistake types</h4>
    <div class="list">${cats.map(([k, v]) => `<a class="row bars" href="#/pattern/${k}">
      <span class="grow">${esc(CATEGORIES[k].label)}<span class="barbg"><i style="width:${(v.count / max) * 100}%"></i></span></span>
      <span class="num">${v.count}</span><span class="chev">›</span></a>`).join('')}</div>

    <h4 class="sub">When it goes wrong</h4>
    <section class="card">
      <ul class="facts">
        <li><b>${pct(low, moments.length)}%</b> of your mistakes happened when you were low on time.</li>
        <li>Opening ${pct(phases.opening, moments.length)}% · Middle of the game ${pct(phases.middlegame, moments.length)}% · Endgame ${pct(phases.endgame, moments.length)}%.</li>
        ${threw ? `<li><b>${threw}</b> game${threw > 1 ? 's' : ''} you were clearly winning (80%+ chances), but didn't win.</li>` : ''}
        ${timeLosses ? `<li><b>${timeLosses}</b> of your ${losses} losses were on time.</li>` : ''}
      </ul>
    </section>

    <h4 class="sub">What you play</h4>
    <section class="card">
      <ul class="facts">${Object.entries(bySpeed).sort((a, b) => b[1].n - a[1].n).map(([s, v]) =>
        `<li>${SPEED_LABEL[s] || s}: ${v.n} games, won ${pct(v.w, v.n)}%</li>`).join('')}</ul>
      ${bulletShare >= 0.4 ? `<div class="habit warnbox"><b>A note on bullet</b><p>${pct(bulletShare * 100, 100)}% of these games are bullet. In 1–2 minute games there's no time to check what your opponent is threatening, so the habits above can't form — bullet mostly practises reflexes. For a few weeks, try playing mostly 10-minute (or longer) games and use the extra time to ask "what does their move attack?" every single move.</p></div>` : ''}
    </section>
  </main>`;
}

function viewPattern(cat) {
  const info = CATEGORIES[cat];
  if (!info) { go('#/report'); return; }
  const { moments } = collect();
  const list = moments.filter((m) => m.category === cat).sort((a, b) => b.game.playedAt - a.game.playedAt || a.ply - b.ply);
  app.innerHTML = `${topbar(info.label, { back: '#/report' })}
  <main>
    <section class="card"><div class="habit"><b>Habit to build</b><p>${esc(info.habit)}</p></div></section>
    <div class="list">${list.map((m) => `<a class="row" href="#/game/${encodeURIComponent(m.game.key)}/${m.ply}">
      <span class="grow"><b>vs ${esc(m.game.opponent)}</b> <small class="muted">· move ${moveNo(m.ply)} · ${fmtDate(m.game.playedAt)}</small><br>
      <small>${esc(m.text)}</small></span><span class="chev">›</span></a>`).join('')}</div>
  </main>`;
}

// ---------------- settings ----------------
function viewSettings() {
  const s = store.settings();
  app.innerHTML = `${topbar('Settings', { back: '#/' })}
  <main>
    <form class="card form" id="sf">
      ${!s.chesscom && !s.lichess ? '<p>Enter your username on one or both sites. It is saved on this device only.</p>' : ''}
      <label>Chess.com username<input name="chesscom" value="${esc(s.chesscom)}" autocomplete="off" autocapitalize="none"></label>
      <label>Lichess username<input name="lichess" value="${esc(s.lichess)}" autocomplete="off" autocapitalize="none"></label>
      <label>Games to get from each site
        <select name="perSite">${[10, 25, 50, 100].map((v) => `<option ${v === s.perSite ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>How carefully to review
        <select name="depth">${Object.entries({ quick: 'Quick (good for phones)', normal: 'Normal', deep: 'Deep (slow)' }).map(([k, v]) => `<option value="${k}" ${k === s.depth ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="autoAnalyze" ${s.autoAnalyze ? 'checked' : ''}> Review new games automatically</label>
      <button class="primary">Save</button>
    </form>
    <section class="card">
      <p class="muted">Changing how carefully games are reviewed only affects new reviews.</p>
      <button class="pill" data-act="reanalyze">Review all games again</button>
      <button class="pill danger" data-act="clear">Delete all data on this device</button>
    </section>
    ${isIOS() && !isStandalone() ? '<section class="card"><p>To install on iPhone: tap Share in Safari, then "Add to Home Screen".</p></section>' : ''}
    <p class="foot muted">Game review by Stockfish (GPL). Pieces by Colin M.L. Burnett (CC BY-SA). Your games and results stay on this device.</p>
  </main>`;
  document.getElementById('sf').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    store.saveSettings({ ...s, chesscom: f.get('chesscom').trim(), lichess: f.get('lichess').trim(), perSite: +f.get('perSite'), depth: f.get('depth'), autoAnalyze: !!f.get('autoAnalyze') });
    go('#/');
    if (!store.games().length && (f.get('chesscom').trim() || f.get('lichess').trim())) refreshGames();
  });
}

// ---------------- global actions ----------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-filter]');
  if (!t) return;
  if (t.dataset.filter) { filter = t.dataset.filter; render({ keepScroll: true }); return; }
  const act = t.dataset.act;
  if (act === 'install') doInstall();
  else if (act === 'back') { if (navDepth > 0) history.back(); else go(t.dataset.to); }
  else if (act === 'replay') render({ keepScroll: true });
  else if (act === 'fetch') refreshGames();
  else if (act === 'pause') { runner.paused = true; showStatus(); }
  else if (act === 'resume') { runner.paused = false; runQueue(); showStatus(); }
  else if (act === 'analyze-now') {
    // move this game to the front of the queue
    const r = route();
    const games = store.games();
    const i = games.findIndex((g) => g.key === r.key);
    if (i > 0) { games.unshift(games.splice(i, 1)[0]); store.saveGames(games); }
    runner.paused = false; runQueue(); render({ keepScroll: true });
  } else if (act === 'reanalyze') {
    if (confirm('Review all games again? This takes a while.')) { localStorage.removeItem('cc.analyses'); runner.paused = false; runQueue(); go('#/'); }
  } else if (act === 'clear') {
    if (confirm('Delete all games, reviews and settings on this device?')) { store.clearAll(); location.hash = '#/'; location.reload(); }
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
if (store.games().length && store.settings().autoAnalyze) runQueue();
window.coach = { store, runner, runQueue };
