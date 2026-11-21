// SVG chessboard: pieces, arrows, square highlights. No coordinates (the user doesn't use notation).
const NS = 'http://www.w3.org/2000/svg';
const COLORS = { good: '#2ea043', bad: '#e5534b', threat: '#f0883e', last: 'rgba(255, 214, 10, .38)' };

function el(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function createBoard(container) {
  const svg = el('svg', { viewBox: '0 0 800 800', class: 'board' });
  container.replaceChildren(svg);
  let flipped = false;

  const xy = (sq) => {
    let f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    if (flipped) { f = 7 - f; r = 7 - r; }
    return [f * 100, (7 - r) * 100];
  };

  function arrow(g, from, to, color, opacity = 0.85) {
    const [x1, y1] = xy(from).map((v) => v + 50);
    const [x2, y2] = xy(to).map((v) => v + 50);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const head = 34, w = 15;
    const bx = x2 - ux * head, by = y2 - uy * head;
    const sx = x1 + ux * 22, sy = y1 + uy * 22;
    const px = -uy, py = ux;
    const pts = [
      [sx + px * w / 2, sy + py * w / 2], [bx + px * w / 2, by + py * w / 2], [bx + px * 22, by + py * 22],
      [x2, y2], [bx - px * 22, by - py * 22], [bx - px * w / 2, by - py * w / 2], [sx - px * w / 2, sy - py * w / 2],
    ];
    g.append(el('polygon', { points: pts.map((p) => p.join(',')).join(' '), fill: COLORS[color] || color, opacity, 'stroke-linejoin': 'round' }));
  }

  /**
   * draw({ fen, flip, arrows:[{from,to,color}], highlights:[{sq,color}], last:{from,to} })
   */
  function draw({ fen, flip = false, arrows = [], highlights = [], last = null }) {
    flipped = flip;
    svg.replaceChildren();
    const g = el('g');
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      g.append(el('rect', { x: f * 100, y: r * 100, width: 100, height: 100, class: (r + f) % 2 ? 'sq-dark' : 'sq-light' }));
    }
    if (last) for (const sq of [last.from, last.to]) {
      const [x, y] = xy(sq);
      g.append(el('rect', { x, y, width: 100, height: 100, fill: COLORS.last }));
    }
    for (const h of highlights) {
      const [x, y] = xy(h.sq);
      g.append(el('circle', { cx: x + 50, cy: y + 50, r: 46, fill: 'none', stroke: COLORS[h.color] || h.color, 'stroke-width': 8, opacity: 0.9 }));
    }
    const rows = fen.split(' ')[0].split('/');
    rows.forEach((row, ri) => {
      let fi = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { fi += +ch; continue; }
        const sq = String.fromCharCode(97 + fi) + (8 - ri);
        const [x, y] = xy(sq);
        const name = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
        g.append(el('image', { href: `img/pieces/${name}.svg`, x: x + 2, y: y + 2, width: 96, height: 96 }));
        fi++;
      }
    });
    const ag = el('g', { class: 'arrows' });
    for (const a of arrows) arrow(ag, a.from, a.to, a.color);
    g.append(ag);
    svg.append(g);
  }

  return { draw, svg };
}
