// "Ask the tutor" screen: board on top, chat below, live cost meter.
import { store } from './store.js';
import { positionsOf } from './analyze.js';
import { createBoard } from './board.js';
import { ask, MODELS, fmtMoney } from './tutor.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Light formatting for tutor text: paragraphs and **bold** only.
const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

export function viewChat(app, { key, ply }, topbar) {
  const g = store.game(key);
  if (!g) { location.hash = '#/'; return () => {}; }
  const a = store.analysis(key);
  const { fens, verbose } = positionsOf(g);
  ply = Math.max(0, Math.min(fens.length - 1, ply || 0));
  const moment = a?.moments?.find((m) => m.ply === ply) || null;
  const fen = fens[ply];
  const flip = g.color === 'b';
  const id = `${key}|${ply}`;
  const chat = store.chat(id);
  const s = store.settings();
  let busy = false;
  let alive = true;

  const suggestions = moment
    ? ['I don\'t see how I lose material here. Show me step by step.', 'Why is the green move better?', 'What should I have noticed before moving?']
    : ['What\'s the plan for me here?', 'What is my opponent threatening?', 'What would a strong player look at first?'];

  function meter() {
    const month = store.monthSpend();
    const budget = +s.monthlyBudget || 0;
    const left = budget ? Math.max(0, budget - month) : null;
    return `<div class="meter">
      <span><b>${fmtMoney(chat.cost)}</b> this chat</span>
      <span><b>${fmtMoney(month)}</b> this month${budget ? ` · <b class="${left < budget * 0.15 ? 'low' : ''}">${fmtMoney(left)}</b> left of ${fmtMoney(budget)}` : ''}</span>
    </div>`;
  }
  const overBudget = () => +s.monthlyBudget > 0 && store.monthSpend() >= +s.monthlyBudget;

  function messagesHtml() {
    if (!chat.visible.length) {
      return `<div class="bubble tutor"><p>Hi! Ask me anything about this position${moment ? ' — for example, how this move lost material, or what to look for next time' : ''}. I'll check every idea with the engine and show it on the board.</p></div>
        <div class="chips wrap sugg">${suggestions.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    }
    return chat.visible.map((m) => m.role === 'me'
      ? `<div class="bubble me">${esc(m.text)}</div>`
      : m.role === 'error' ? `<div class="bubble err">${esc(m.text)}</div>`
      : `<div class="bubble tutor">${fmt(m.text)}${m.board ? '<button class="link" data-show="' + chat.visible.indexOf(m) + '">Show on board</button>' : ''}<small class="muted cost">${fmtMoney(m.cost || 0)} · ${esc(MODELS[m.model]?.short || m.model || '')}</small></div>`).join('');
  }

  const noKey = !s.apiKey;
  app.innerHTML = `${topbar('Ask the tutor', { back: `#/game/${encodeURIComponent(key)}/${ply}` })}
  <main class="chat">
    <div id="cboard" class="boardwrap small"></div>
    <div id="meter">${noKey ? '' : meter()}</div>
    ${noKey ? `<section class="card">
        <h3>Set up the tutor first</h3>
        <p>The tutor uses Claude through your own Anthropic API key. You pay Anthropic directly — usually a few cents per question.</p>
        <a class="pill" href="#/settings">Open Settings ›</a>
      </section>` : `<div id="msgs" class="msgs">${messagesHtml()}</div>
      ${busy ? '' : ''}
      <form id="cf" class="composer">
        <textarea name="q" rows="1" placeholder="Ask about this position…" ${overBudget() ? 'disabled' : ''}></textarea>
        <button class="primary send" ${overBudget() ? 'disabled' : ''}>Send</button>
      </form>
      ${overBudget() ? '<p class="error">You\'ve reached the monthly budget you set in Settings, so the tutor is paused. Raise it in Settings to keep going.</p>' : ''}`}
  </main>`;

  const board = createBoard(document.getElementById('cboard'));
  let shown = { fen, arrows: moment ? moment.arrows : [] };
  const last = verbose[ply - 1] ? { from: verbose[ply - 1].from, to: verbose[ply - 1].to } : null;
  const draw = () => board.draw({ fen: shown.fen, flip, arrows: shown.arrows, last: shown.fen === fen ? last : null });
  draw();
  if (noKey) return () => { alive = false; };

  const msgs = document.getElementById('msgs');
  const form = document.getElementById('cf');
  const ta = form.q;
  const scrollDown = () => { msgs.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' }); };
  const refresh = () => {
    msgs.innerHTML = messagesHtml() + (busy ? '<div class="bubble tutor thinking"><p>Thinking… (checking with the engine)</p></div>' : '');
    document.getElementById('meter').innerHTML = meter();
    bind();
    scrollDown();
  };
  function bind() {
    msgs.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => send(b.dataset.q));
    msgs.querySelectorAll('[data-show]').forEach((b) => b.onclick = () => {
      shown = chat.visible[+b.dataset.show].board; draw();
      document.getElementById('cboard').scrollIntoView({ behavior: 'smooth' });
    });
  }
  bind();
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy || overBudget()) return;
    busy = true;
    ta.value = ''; ta.style.height = 'auto';
    chat.visible.push({ role: 'me', text });
    refresh();
    let boardForAnswer = null;
    const model = s.tutorModel || 'claude-sonnet-5-5';
    try {
      const r = await ask({
        apiKey: s.apiKey, model, history: chat.history, question: text,
        context: chat.history.length ? null : (await import('./tutor.js')).contextText({ game: g, ply, fen, moment, me: g.color }),
        ctx: {
          me: g.color, engineOpts: { depth: 12, movetime: 600 },
          onBoard: (b) => { boardForAnswer = b; if (alive) { shown = b; draw(); } },
        },
        onCost: (c, servedBy, usage) => {
          chat.cost += c;
          store.addSpend({ cost: c, model: servedBy, in: usage?.input_tokens, out: usage?.output_tokens, cacheRead: usage?.cache_read_input_tokens });
          if (alive) document.getElementById('meter').innerHTML = meter();
        },
        fetchImpl: window.__coachFetch, // test hook; undefined in normal use
      });
      chat.visible.push({ role: 'tutor', text: r.text, cost: r.cost, model, board: boardForAnswer });
    } catch (err) {
      chat.visible.push({ role: 'error', text: err.message || String(err) });
    } finally {
      busy = false;
      store.saveChat(id, chat);
      if (alive) refresh();
    }
  }
  return () => { alive = false; };
}
