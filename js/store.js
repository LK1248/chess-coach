// localStorage persistence: settings, fetched games, analyses.
const K = { settings: 'cc.settings', games: 'cc.games', analyses: 'cc.analyses' };

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const DEFAULT_SETTINGS = { chesscom: '', lichess: '', perSite: 25, depth: 'normal', autoAnalyze: true };
export const DEPTHS = { quick: { depth: 10, movetime: 400 }, normal: { depth: 12, movetime: 700 }, deep: { depth: 15, movetime: 1500 } };

export const store = {
  settings() { return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) }; },
  saveSettings(s) { write(K.settings, s); },
  games() { return read(K.games, []); },
  saveGames(list) { write(K.games, list); },
  game(key) { return this.games().find((g) => g.key === key); },
  analyses() { return read(K.analyses, {}); },
  analysis(key) { return this.analyses()[key]; },
  saveAnalysis(key, a) {
    const all = this.analyses();
    all[key] = a;
    try { write(K.analyses, all); } catch {
      // storage full: drop analyses of games that are no longer in the list
      const keep = new Set(this.games().map((g) => g.key));
      for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
      write(K.analyses, all);
    }
  },
  /** merge newly fetched games, keep newest first, cap size */
  mergeGames(fresh, cap = 200) {
    const byKey = new Map(this.games().map((g) => [g.key, g]));
    for (const g of fresh) byKey.set(g.key, g);
    const list = [...byKey.values()].sort((a, b) => b.playedAt - a.playedAt).slice(0, cap);
    this.saveGames(list);
    return list;
  },
  clearAll() { Object.values(K).forEach((k) => localStorage.removeItem(k)); },
};
