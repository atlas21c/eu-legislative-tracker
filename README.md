# EU Legislative Tracker

Where each EU co-decision file stands, from Commission proposal to the Official Journal.
Data: European Parliament Open Data Portal (procedures API v2). A scheduled GitHub Action
(`.github/workflows/update-data.yml`) refreshes `data/data.json` every 4 hours; `index.html` reads it.

- `scripts/update.mjs`: the updater
- `data/data.json`: current data (written by the updater)
- `data/title-overrides.json`: optional shortened titles, keyed by file number
