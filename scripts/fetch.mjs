// Fetches every issue in the target repo through the GitHub GraphQL API and
// stores a compact record per issue in data/issues.json.
//
// The fetch is incremental. It walks issues in ascending `updatedAt` order
// from the last high-water mark, so a rerun only pulls changed issues. The
// script saves progress every few pages, so an interrupted run resumes.

import { execSync } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Configuration

const OWNER = "anthropics";
const REPO = "claude-code";
const DATA_FILE = new URL("../data/issues.json", import.meta.url);
const PAGE_SIZE = 100;
const SAVE_EVERY = 20;

const token =
  process.env.GITHUB_TOKEN ??
  execSync("gh auth token", { encoding: "utf8" }).trim();

// ---------------------------------------------------------------------------
// Record encoding
//
// One issue is the array [createdAt, closedAt, reason, closer, flags].
// Times are Unix seconds. `closedAt` is null for open issues.
//   reason: "c" completed, "n" not planned, "d" duplicate, null when open
//   closer: "b" bot, "a" the issue author, "h" another human, null when open
//   flags:  a string of label letters, "s" stale, "i" invalid, "d" duplicate

/** @param {string | null} iso */
const toSeconds = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

const REASONS = { COMPLETED: "c", NOT_PLANNED: "n", DUPLICATE: "d" };
const FLAG_LABELS = { stale: "s", invalid: "i", duplicate: "d" };

/** @returns {[number, number | null, string | null, string | null, string]} */
function encode(node) {
  const closedAt = node.state === "CLOSED" ? toSeconds(node.closedAt) : null;
  const actor = node.timelineItems.nodes[0]?.actor;
  let closer = null;
  if (closedAt !== null) {
    if (!actor || actor.__typename === "Bot" || actor.login.endsWith("[bot]"))
      closer = "b";
    else if (actor.login === node.author?.login) closer = "a";
    else closer = "h";
  }
  const flags = node.labels.nodes
    .map((l) => FLAG_LABELS[l.name] ?? "")
    .join("");
  return [
    toSeconds(node.createdAt),
    closedAt,
    closedAt === null ? null : REASONS[node.stateReason] ?? "c",
    closer,
    flags,
  ];
}

// ---------------------------------------------------------------------------
// GraphQL

const QUERY = `
query($owner: String!, $repo: String!, $since: DateTime, $after: String, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    issues(first: $n, after: $after,
           orderBy: {field: UPDATED_AT, direction: ASC},
           filterBy: {since: $since}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number state createdAt closedAt updatedAt stateReason
        author { login }
        labels(first: 20) { nodes { name } }
        timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes { ... on ClosedEvent { actor { __typename login } } }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

async function graphql(variables, attempt = 0) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "User-Agent": "dogfood-bench" },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body?.data) return body.data;
  // GitHub returns 502 for slow queries now and then. Back off and retry.
  if (attempt < 6) {
    const wait = 2 ** attempt * 2000;
    console.error(`retry ${attempt + 1} after ${res.status}: ${JSON.stringify(body?.errors ?? "")}`);
    await new Promise((r) => setTimeout(r, wait));
    return graphql(variables, attempt + 1);
  }
  throw new Error(`GraphQL failed: ${res.status} ${JSON.stringify(body)}`);
}

// ---------------------------------------------------------------------------
// Persistence

async function load() {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    return { repo: `${OWNER}/${REPO}`, since: null, cursor: null, fetchedAt: null, issues: {} };
  }
}

async function save(db) {
  const tmp = new URL("../data/issues.json.tmp", import.meta.url);
  await writeFile(tmp, JSON.stringify(db));
  await rename(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------------
// Main

const db = await load();
let maxUpdated = db.since;
let pages = 0;

for (;;) {
  const data = await graphql({
    owner: OWNER,
    repo: REPO,
    since: db.since,
    after: db.cursor,
    n: PAGE_SIZE,
  });
  const { nodes, pageInfo } = data.repository.issues;
  for (const node of nodes) {
    db.issues[node.number] = encode(node);
    if (!maxUpdated || node.updatedAt > maxUpdated) maxUpdated = node.updatedAt;
  }
  db.cursor = pageInfo.endCursor ?? db.cursor;
  pages++;
  if (pages % SAVE_EVERY === 0) {
    await save(db);
    console.error(
      `${pages} pages, ${Object.keys(db.issues).length} issues, ` +
        `at ${maxUpdated}, rate ${data.rateLimit.remaining}`,
    );
  }
  if (!pageInfo.hasNextPage) break;
}

// The walk is complete. Next run starts from the newest update we saw.
db.since = maxUpdated;
db.cursor = null;
db.fetchedAt = new Date().toISOString();
await save(db);
console.error(`done: ${Object.keys(db.issues).length} issues`);
