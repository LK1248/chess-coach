# Chess Coach — notes for Claude

Reviews the user's Chess.com (LotanKap) and Lichess (LK1248) games with Stockfish in the browser and explains
mistakes in plain English. Plain HTML/CSS/ES modules, no build step. Phone-first, installable (PWA), like Ember.

## User decisions
- NO chess notation anywhere in the UI: describe moves in words ("take their rook with your bishop") + arrows/highlights.
  No board coordinates either.
- Phase 1 (done): game review + pattern report. Phase 2 (next): drills from the user's own mistakes (spaced
  repetition) and coached practice games vs a bot at their level that warns before a blunder.

## Run / test
- `python tools/serve.py` → http://localhost:5342 (launch config "coach"). `window.coach` = { store, runner, runQueue }.
- Lichess API rejects curl's default User-Agent (404); browsers are fine.

## Architecture
- `games.js` fetch + normalise games (standard chess only; Chess.com `rules === 'chess'`), clocks from `%clk`.
- `engine.js` Stockfish 17.1 lite single-threaded (vendor/, 7 MB wasm; no SharedArrayBuffer so it works on GitHub Pages).
- `analyze.js` evals every position, win% (Lichess curve), mistake ≥10 / big mistake ≥20 drop for the user's moves.
  `explain()` categorises by playing out the engine line and finding the capture where the user falls ≥2 points behind.
  Bump `ANALYSIS_VERSION` when changing output — games get re-reviewed automatically.
- `main.js` hash router: home, game review (`#/game/<key>/<ply>`), report, pattern list, settings; background review queue.
- `store.js` localStorage. `board.js` SVG board. `sw.js` network-first app files, cache-first vendor/img.
- Pieces: cburnett (CC BY-SA, Colin M.L. Burnett) from lichess-org/lila.
