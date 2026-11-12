# Crude fact-sheet extraction (one report date)

You turn ONE day's Platts Oilgram reports into a compact, structured JSON fact sheet. The fact sheets feed a
walk-forward backtest of crude-oil scenario forecasts, so two rules matter more than anything else:

1. **Use only the bundle file you were given.** Do not open any other file in the bundles or reports folders, and
   do not use outside knowledge of events. Anything not stated in this bundle must not appear in the output.
2. **Numbers verbatim.** Copy figures exactly as printed, with units and the as-of date the text gives. Never
   compute, round or infer a figure. If a figure's date is unclear, put `null` in `as_of`.

## Input
`bundles/YYYY-MM-DD.txt` under backend/data/fundamentals (built by `python -m app.fundamentals.bundle`), unless your
task names another file; write the output to `facts/YYYY-MM-DD.json` there. The bundle is a UTF-8 text file: the Oilgram News issue, then zero, one or two Oilgram Price Report issues (crude-relevant
pages plus a few crude price tables). It can be large; read it in chunks with the Read tool's offset/limit until
you have covered all of it. Page breaks are form feeds.

## What to extract (crude oil only; skip products, LPG, gas, power, climate, unless it states a direct crude impact)
- **prices**: crude benchmark prices and spreads stated in the text or the crude tables. Always include, when present:
  ICE Brent front-month settle and change, NYMEX WTI front-month settle and change, Dated Brent, Dubai,
  Murban, Oman, physical Brent vs futures (or Dated vs front-line), Brent CFD / prompt spreads, Brent and WTI
  futures time spreads, WTI Midland, Urals, Saudi OSP changes.
- **flows**: export / loading / transit volumes (Hormuz, Persian Gulf, Saudi total, Yanbu, Ras Tanura, Iraq,
  Kuwait, UAE, Fujairah, SUMED / Sidi Kerir, Red Sea, Russia, CPC, US, China imports, India imports, etc.).
- **supply**: production levels and changes, OPEC+ survey numbers, shut-ins, outages and restarts, quota decisions,
  meeting dates.
- **demand_inventories**: stocks (US EIA/API, ARA, Singapore, Fujairah, China, global), refinery runs and
  outages that affect crude demand, SPR actions, demand estimates.
- **physical_market**: grade differentials, unsold cargoes, tender results, freight rates (VLCC, Suezmax, Aframax)
  and war-risk insurance, arbitrage commentary.
- **forecasts**: price or balance forecasts by agencies and banks (EIA, IEA, OPEC, CERA, banks) with horizon.
- **events**: dated geopolitical and operational events: attacks, strikes, ceasefire or peace-talk statements,
  sanctions, shipping incidents, pipeline outages, policy decisions. One line each.
- **themes**: the 4–8 market themes this day's reports put weight on, each with a short name, how many separate
  articles touch it, the direction the reports imply for crude (bullish / bearish / mixed), and one sentence
  stating what the reports say (facts, not your opinion).

## Output
Write the JSON file to the output path you were given (use the Write tool), exactly this shape:

```json
{
  "report_date": "YYYY-MM-DD",
  "sources": ["oilgram_news YYYY-MM-DD", "oilgram_price YYYY-MM-DD"],
  "prices":             [{"name": "", "value": "", "unit": "", "as_of": "YYYY-MM-DD or null", "change": "", "page": 0}],
  "flows":              [{"metric": "", "value": "", "unit": "", "period": "", "source": "", "page": 0}],
  "supply":             [{"metric": "", "value": "", "unit": "", "period": "", "page": 0}],
  "demand_inventories": [{"metric": "", "value": "", "unit": "", "period": "", "page": 0}],
  "physical_market":    [{"metric": "", "value": "", "unit": "", "as_of": "", "page": 0}],
  "forecasts":          [{"who": "", "what": "", "value": "", "horizon": "", "page": 0}],
  "events":             [{"date": "YYYY-MM-DD or null", "category": "attack|conflict|diplomacy|sanctions|policy|outage|shipping|weather|other", "region": "", "what": "", "crude_impact": "bullish|bearish|mixed|neutral", "page": 0}],
  "themes":             [{"theme": "", "articles": 0, "direction": "bullish|bearish|mixed", "summary": ""}]
}
```

`page` is the page number printed in the report (or the form-feed page index if none), and use `"page": null`
when unsure. `value` stays a string so units like "4.4 million b/d" or "-$2.12/b" survive. Keep the whole file
under about 20 KB: prefer the figures a crude trader would act on, and do not repeat the same figure.

When done, reply with one line: the output path and the counts per section.
