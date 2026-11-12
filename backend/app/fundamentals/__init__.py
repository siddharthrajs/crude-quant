"""Fundamental scenarios from the daily Platts Oilgram reports (stored in the `fnd` schema, migration 0016).

A day's pipeline, run from backend/ (each step is `python -m app.fundamentals.<step>`):

  fetch     download Oilgram News and Oilgram Price Report PDFs for a date range
  bundle    extract their text and build one crude-only text bundle per report date
  (Claude)  turn each bundle into a fact sheet, following prompts/fact_sheet.md
  (Claude)  forecast the day's scenarios, following prompts/forecaster.md, using `prices` for settlements up to the
            day and `apply_day` to write the run file and update the state
  load      load reports, fact sheets and run files into fnd.*; price tests resolve from qh_settlements
  score     score resolved scenario sets against simple baselines

Working files live under settings.fundamentals_dir (git-ignored: it holds licensed Platts content):
  reports/{news,price}_YYYY-MM-DD.pdf, text/ and text_layout/ (pdftotext output), bundles/YYYY-MM-DD.txt,
  facts/YYYY-MM-DD.json, runs/YYYY-MM-DD.json, state.json.
"""
