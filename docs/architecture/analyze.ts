// Generates the interactive C4 diagram: docs/architecture/model.json and index.html.
//
//   bun docs/architecture/analyze.ts                 # the working tree
//   bun docs/architecture/analyze.ts --base main     # ... plus what changed since `main`
//   bun docs/architecture/analyze.ts --base main --head HEAD   # two commits, ignoring the working tree
//
// With --base, the base commit is exported with `git archive` to a temporary directory and analyzed
// the same way; elements are matched by id and marked added / removed / changed.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, type MEdge, type MNode, type Model } from "./model.ts";

const ROOT = join(import.meta.dir, "../..");
const OUT = import.meta.dir;

const git = (args: string[], cwd = ROOT) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Export `ref` and analyze it, resolving @kagi/* to that commit's sources (not the current ones). */
function analyzeRef(ref: string): Model {
  const dir = mkdtempSync(join(tmpdir(), "kagi-base-"));
  try {
    const tar = Bun.spawnSync(["git", "archive", "--format=tar", ref], { cwd: ROOT });
    if (tar.exitCode !== 0) throw new Error(`git archive ${ref}: ${tar.stderr.toString()}`);
    const x = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: tar.stdout });
    if (x.exitCode !== 0) throw new Error(`tar: ${x.stderr.toString()}`);

    // Third-party packages come from the current install; workspace packages from the base commit.
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const paths: Record<string, string[]> = {};
    for (const area of ["packages", "apps"]) {
      if (!existsSync(join(dir, area))) continue;
      for (const name of readdirSync(join(dir, area))) {
        const pj = join(dir, area, name, "package.json");
        if (!existsSync(pj)) continue;
        const pkg = JSON.parse(readFileSync(pj, "utf8")) as { name: string; exports?: { ".": string } };
        const entry = pkg.exports?.["."];
        if (entry) paths[pkg.name] = [join(area, name, entry)];
        if (existsSync(join(ROOT, area, name, "node_modules"))) symlinkSync(join(ROOT, area, name, "node_modules"), join(dir, area, name, "node_modules"));
      }
    }
    return buildModel(dir, { compilerOptions: { baseUrl: dir, paths } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const edgeKey = (e: MEdge) => `${e.view}|${e.from}|${e.to}|${e.kind}`;
const NODE_FIELDS = ["name", "kind", "group", "technology", "description"] as const;
const EDGE_FIELDS = ["label", "condition"] as const;

/** Union of both models; every element carries `diff` = added | removed | changed (and `before`). */
function diffModels(base: Model, head: Model, baseRef: string) {
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const nodes: Array<MNode & { diff?: string; before?: Record<string, unknown> }> = [];
  for (const n of head.nodes) {
    const b = baseNodes.get(n.id);
    if (!b) nodes.push({ ...n, diff: "added" });
    else {
      const before = Object.fromEntries(NODE_FIELDS.filter((f) => (b[f] ?? "") !== (n[f] ?? "")).map((f) => [f, b[f] ?? null]));
      nodes.push(Object.keys(before).length ? { ...n, diff: "changed", before } : n);
    }
  }
  for (const b of base.nodes) if (!headNodes.has(b.id)) nodes.push({ ...b, diff: "removed" });

  const baseEdges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  const headKeys = new Set(head.edges.map(edgeKey));
  const edges: Array<MEdge & { diff?: string; before?: Record<string, unknown> }> = [];
  for (const e of head.edges) {
    const b = baseEdges.get(edgeKey(e));
    if (!b) edges.push({ ...e, diff: "added" });
    else {
      const before = Object.fromEntries(EDGE_FIELDS.filter((f) => (b[f] ?? "") !== (e[f] ?? "")).map((f) => [f, b[f] ?? null]));
      edges.push(Object.keys(before).length ? { ...e, diff: "changed", before } : e);
    }
  }
  for (const b of base.edges) if (!headKeys.has(edgeKey(b))) edges.push({ ...b, diff: "removed" });

  const headViews = new Map(head.views.map((v) => [v.id, v]));
  const views = head.views.map((v) => {
    const bv = base.views.find((x) => x.id === v.id);
    return { ...v, nodes: [...new Set([...v.nodes, ...(bv?.nodes ?? [])])], ...(!bv && { diff: "added" }) };
  });
  for (const bv of base.views) if (!headViews.has(bv.id)) views.push({ ...bv, diff: "removed" });

  const count = (xs: Array<{ diff?: string }>, d: string) => xs.filter((x) => x.diff === d).length;
  return {
    ...head,
    nodes,
    edges,
    views,
    base: { ref: baseRef, commit: git(["rev-parse", "--short", baseRef]) },
    summary: {
      nodes: { added: count(nodes, "added"), removed: count(nodes, "removed"), changed: count(nodes, "changed") },
      edges: { added: count(edges, "added"), removed: count(edges, "removed"), changed: count(edges, "changed") },
    },
  };
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const baseRef = arg("--base");
const headRef = arg("--head");

const head = headRef ? analyzeRef(headRef) : buildModel(ROOT);
head.generatedFrom = headRef
  ? git(["rev-parse", "--short", headRef])
  : git(["rev-parse", "--short", "HEAD"]) + (git(["status", "--porcelain", "--", "packages", "apps", "scripts"]) ? "+dirty" : "");
const model = baseRef ? diffModels(analyzeRef(baseRef), head, baseRef) : head;

writeFileSync(join(OUT, "model.json"), `${JSON.stringify(model, null, 2)}\n`);
const template = readFileSync(join(OUT, "template.html"), "utf8");
writeFileSync(join(OUT, "index.html"), template.replace("/*__MODEL__*/null", JSON.stringify(model).replace(/</g, "\\u003c")));
const s = "summary" in model ? model.summary : undefined;
console.log(
  `${model.nodes.length} nodes, ${model.edges.length} edges` +
    (s ? `; vs ${baseRef}: nodes +${s.nodes.added} -${s.nodes.removed} ~${s.nodes.changed}, edges +${s.edges.added} -${s.edges.removed} ~${s.edges.changed}` : "") +
    " → docs/architecture/index.html",
);
