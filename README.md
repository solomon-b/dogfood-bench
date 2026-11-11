# Dogfood Bench

A half serious AI benchmark. Anthropic builds Claude Code with Claude Code. If
AI makes engineers more productive, the `anthropics/claude-code` issue tracker
should show it. This site measures how fast those issues get fixed.

## How it works

1. `scripts/fetch.mjs` reads every issue through the GitHub GraphQL API. It
   stores a compact record per issue in `data/issues.json`. Later runs fetch
   only the issues that changed since the last run.
2. `scripts/build.mjs` reduces the records to weekly series and writes
   `site/data.json`.
3. `site/` is a static page with no dependencies. It draws the charts as SVG.

Each closure goes into one bucket: fixed, declined, closed by author, or bot
sweep. Only "fixed" counts as work. The page explains the method in full.

## Run it locally

```sh
npm run fetch   # needs `gh auth login` or GITHUB_TOKEN; the first run takes about 25 minutes
npm run build
npm run serve   # then open http://localhost:8080
```

## Deploy

The workflow in `.github/workflows/deploy.yml` runs daily. It fetches new
data, commits `data/issues.json`, builds, and deploys `site/` to GitHub Pages.
In the repo settings, set Pages to deploy from GitHub Actions.

Commit a full `data/issues.json` before the first workflow run. The Actions
token has a lower GraphQL rate limit, so it is not good for the first full
fetch.

## Model releases

`site/releases.json` lists the model releases that the charts mark. Add new
releases to that file.
