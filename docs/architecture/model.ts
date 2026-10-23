// Builds a C4 model (context → containers → components → code) of KAGI from the source, using
// the TypeScript type checker (ts-morph). See README.md for what is analyzed and what is hand-added.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type CallExpression, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";

const PORTS_FILE = "packages/core/src/types.ts";

// ---- Presentation tables (names only; whether an edge exists comes from the code) -------------

/** Library functions that talk to a remote system, keyed by npm package. */
export const NETWORK_CALLS: Record<string, { system: string; fns: string[] }> = {
  "openid-client": { system: "oidc", fns: ["discovery", "authorizationCodeGrant", "fetchUserInfo"] },
  jose: { system: "oidc", fns: ["createRemoteJWKSet"] },
  "@clerk/backend": { system: "clerk", fns: ["authenticateRequest", "getUser"] },
};
export const EXTERNAL_NAMES: Record<string, { name: string; tech: string; description: string }> = {
  oidc: { name: "OpenID Connect provider", tech: "OIDC", description: "Signs people in and issues ID tokens (e.g. Pocket ID). Also the issuer of bearer JWTs for the API." },
  clerk: { name: "Clerk", tech: "SaaS", description: "Optional identity provider used through its SDK." },
  "app.candyhouse.co": { name: "SESAME Web API", tech: "HTTPS, AES-CMAC", description: "CANDY HOUSE cloud; reaches the lock through Hub3 / Wi-Fi Module 2." },
  "api.switch-bot.com": { name: "SwitchBot Cloud API", tech: "HTTPS, HMAC-SHA256", description: "SwitchBot OpenAPI v1.1; reaches the lock through a SwitchBot Hub." },
  stdout: { name: "Log stream", tech: "stdout JSON lines", description: "Audit trail. On Cloud Run it lands in Cloud Logging." },
  "configured-http": { name: "Authorization endpoint", tech: "HTTPS (URL from config)", description: "Optional external decision point, e.g. a shift system." },
};

// ---- Model ------------------------------------------------------------------------------------

export type Level = "context" | "container" | "component" | "code";
export interface Evidence {
  file: string;
  line: number;
  text: string;
}
export interface MNode {
  id: string;
  level: Level[];
  kind: string; // person | system | external | container | component | function | interface | library
  group?: string; // port name / "route" / "config" for components
  name: string;
  technology?: string;
  description?: string;
  parent?: string; // view this node drills down into is keyed by node id
  source?: Evidence;
  manual?: boolean;
}
export interface MEdge {
  from: string;
  to: string;
  level: Level;
  view: string; // which view the edge belongs to
  label: string;
  kind: "uses" | "wires" | "calls" | "defines" | "implements";
  condition?: string;
  evidence: Evidence[];
  manual?: boolean;
}

export interface View {
  id: string;
  level: string;
  title: string;
  subject: string;
  nodes: string[];
}
export interface Model {
  generatedFrom: string;
  repository: string;
  ports: string[];
  nodes: MNode[];
  edges: MEdge[];
  views: View[];
}

/** Analyze the workspace at `ROOT`. `compilerOptions` overrides tsconfig (used to analyze an exported old commit). */
export function buildModel(ROOT: string, opts: { compilerOptions?: Record<string, unknown> } = {}): Model {
  const nodes = new Map<string, MNode>();
  const edges: MEdge[] = [];
  const addNode = (n: MNode) => {
    const prev = nodes.get(n.id);
    if (prev) prev.level = [...new Set([...prev.level, ...n.level])];
    else nodes.set(n.id, n);
  };
  const addEdge = (e: MEdge) => {
    const same = edges.find((x) => x.from === e.from && x.to === e.to && x.view === e.view && x.kind === e.kind);
    if (!same) return void edges.push(e);
    const labels = new Set([...same.label.split(", "), ...e.label.split(", ")].filter(Boolean));
    same.label = [...labels].join(", ");
    for (const ev of e.evidence) if (!same.evidence.some((x) => x.file === ev.file && x.line === ev.line)) same.evidence.push(ev);
    if (e.condition && same.condition !== e.condition) same.condition = [same.condition, e.condition].filter(Boolean).join(" | ");
  };

  // ---- Project ------------------------------------------------------------------------------------

  const project = new Project({ tsConfigFilePath: join(ROOT, "tsconfig.json"), ...(opts.compilerOptions && { compilerOptions: opts.compilerOptions }) });
  const rel = (p: string) => relative(ROOT, p);
  const isTest = (f: SourceFile) => /\.test\.tsx?$|\.e2e\.ts$/.test(f.getFilePath());
  const inWorkspace = (n: Node) => {
    const f = n.getSourceFile();
    return !f.isDeclarationFile() && !f.getFilePath().includes("/node_modules/");
  };
  const sources = project.getSourceFiles().filter((f) => inWorkspace(f) && !isTest(f) && !rel(f.getFilePath()).startsWith("e2e/") && !rel(f.getFilePath()).startsWith("docs/"));
  const ev = (n: Node, text?: string): Evidence => ({
    file: rel(n.getSourceFile().getFilePath()),
    line: n.getStartLineNumber(),
    text: (text ?? n.getText()).replace(/\s+/g, " ").slice(0, 160),
  });
  const pkgOf = (file: string) => {
    const m = /^(packages|apps)\/([^/]+)\//.exec(file);
    if (!m) return file;
    try {
      return JSON.parse(readFileSync(join(ROOT, m[1] as string, m[2] as string, "package.json"), "utf8")).name as string;
    } catch {
      return `${m[1]}/${m[2]}`;
    }
  };
  const firstSentence = (s: string | undefined) => s?.replace(/\s+/g, " ").trim().match(/^.*?[.。](\s|$)/)?.[0]?.trim() ?? s?.replace(/\s+/g, " ").trim();
  function declsOf(n: Node): Node[] {
    let sym = n.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol();
    return sym?.getDeclarations() ?? [];
  }
  function libraryOf(decl: Node): string | undefined {
    const m = /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(decl.getSourceFile().getFilePath());
    return m?.[1];
  }

  // ---- Ports: interfaces in core with methods ------------------------------------------------------

  const portsFile = project.getSourceFileOrThrow(join(ROOT, PORTS_FILE));
  const ports = new Map(
    portsFile
      .getInterfaces()
      .filter((i) => i.getMethods().length > 0)
      .map((i) => [i.getName(), i] as const),
  );
  const portOfDecl = (d: Node): string | undefined => {
    if (!Node.isMethodSignature(d)) return undefined;
    const iface = d.getParentIfKind(SyntaxKind.InterfaceDeclaration);
    return iface && ports.get(iface.getName()) === iface ? iface.getName() : undefined;
  };

  // ---- Components (L3) ---------------------------------------------------------------------------

  interface Component {
    id: string;
    group: string; // port implemented, "route", or "config"
    roots: Node[]; // function-likes whose bodies make up the component
    node: MNode;
  }
  const components = new Map<string, Component>();
  const factoryDecls = new Map<Node, string>(); // FunctionDeclaration -> component id

  // (a) factories whose return type is a port
  for (const sf of sources) {
    for (const fn of sf.getFunctions()) {
      const t = fn.getReturnType();
      const sym = t.getAliasSymbol() ?? t.getSymbol();
      const port = sym?.getName();
      if (!port || !ports.has(port) || !sym?.getDeclarations().some((d) => d.getSourceFile() === portsFile)) continue;
      const name = fn.getName() ?? "(anonymous)";
      const file = rel(sf.getFilePath());
      const id = `cmp:${name}`;
      const doc = fn.getJsDocs()[0]?.getDescription();
      factoryDecls.set(fn, id);
      components.set(id, {
        id,
        group: port,
        roots: [fn],
        node: { id, level: ["component"], kind: "component", group: port, name: `${name}()`, technology: `${pkgOf(file)} · ${port}`, ...(doc && { description: firstSentence(doc) }), source: ev(fn.getNameNode() ?? fn, `function ${name}(…): ${t.getText(fn)}`) },
      });
    }
  }

  // (b) HTTP routes registered on a Hono app; descriptions from the app factory's JSDoc route table
  for (const sf of sources) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName();
      if (!["get", "post", "put", "delete", "all"].includes(method)) continue;
      if (!/\bHono\b/.test(callee.getExpression().getType().getText(callee))) continue;
      const [pathArg, ...handlers] = call.getArguments();
      if (!pathArg || !Node.isStringLiteral(pathArg)) continue;
      const verb = method === "all" ? "*" : method.toUpperCase();
      const path = pathArg.getLiteralValue();
      const id = `route:${verb} ${path}`;
      const host = call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
      const table = host?.getJsDocs()[0]?.getDescription() ?? "";
      const row = table.split("\n").find((l) => l.trim().startsWith(`${verb === "*" ? "*" : verb} `) && l.includes(` ${path} `.trimEnd()));
      const description = row?.replace(/^\s*\S+\s+\S+\s+/, "").trim();
      components.set(id, {
        id,
        group: "route",
        roots: handlers.filter((h) => Node.isArrowFunction(h) || Node.isFunctionExpression(h)),
        node: { id, level: ["component"], kind: "component", group: "route", name: `${verb} ${path}`, technology: `${pkgOf(rel(sf.getFilePath()))} · Hono route`, ...(description && { description }), source: ev(call, `app.${method}("${path}", …)`) },
      });
    }
  }

  // (c) composition roots: functions that call factories but are not factories themselves
  const factoryCalls: Array<{ call: CallExpression; target: string }> = [];
  for (const sf of sources) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = declsOf(Node.isPropertyAccessExpression(call.getExpression()) ? (call.getExpression() as Node).getChildrenOfKind(SyntaxKind.Identifier).at(-1) ?? call.getExpression() : call.getExpression())
        .map((d) => factoryDecls.get(d))
        .find(Boolean);
      if (target) factoryCalls.push({ call, target });
    }
  }
  for (const { call } of factoryCalls) {
    const host = call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
    if (!host && !call.getFirstAncestor((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isMethodDeclaration(a))) {
      // Wiring at the top level of a module (e.g. an entry file) is a composition root too.
      const sf = call.getSourceFile();
      const file = rel(sf.getFilePath());
      const id = `cmp:module:${file}`;
      if (!components.has(id)) {
        components.set(id, {
          id,
          group: "config",
          roots: [sf],
          node: { id, level: ["component"], kind: "component", group: "config", name: file.split("/").at(-1) as string, technology: `${pkgOf(file)} · composition root (module)`, source: ev(sf.getStatements()[0] ?? sf, file) },
        });
      }
      continue;
    }
    if (!host || factoryDecls.has(host) || host.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)) continue;
    const name = host.getName() ?? "(anonymous)";
    const id = `cmp:${name}`;
    if (components.has(id)) continue;
    const file = rel(host.getSourceFile().getFilePath());
    const doc = host.getJsDocs()[0]?.getDescription();
    components.set(id, {
      id,
      group: "config",
      roots: [host],
      node: { id, level: ["component"], kind: "component", group: "config", name: `${name}()`, technology: `${pkgOf(file)} · composition root`, ...(doc && { description: firstSentence(doc) }), source: ev(host.getNameNode() ?? host, `function ${name}(…)`) },
    });
  }

  // ---- Containers (L2): entry files and what they reach through imports ------------------------------

  const importedBy = new Set<string>();
  const importsOf = (sf: SourceFile) =>
    [...sf.getImportDeclarations(), ...sf.getExportDeclarations()].map((d) => d.getModuleSpecifierSourceFile()).filter((f): f is SourceFile => !!f && inWorkspace(f));
  for (const sf of sources) for (const f of importsOf(sf)) importedBy.add(f.getFilePath());
  const entries = sources.filter((sf) => /^(apps\/[^/]+\/src|scripts)\//.test(rel(sf.getFilePath())) && !importedBy.has(sf.getFilePath()));

  interface Container {
    id: string;
    entry: SourceFile;
    files: Set<string>;
  }
  const containers: Container[] = [];
  for (const entry of entries) {
    const files = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const f = stack.pop() as SourceFile;
      if (files.has(f.getFilePath())) continue;
      files.add(f.getFilePath());
      stack.push(...importsOf(f));
    }
    const text = entry.getFullText();
    const isServer = /\bBun\.serve\(/.test(text);
    const isCli = /\bprocess\.argv\b/.test(text);
    const file = rel(entry.getFilePath());
    const usesHono = [...files].some((p) => project.getSourceFile(p)?.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === "hono"));
    const id = `ctr:${file}`;
    // First sentence of the file's leading comment (usage lines after it are left out)
    const header = firstSentence(entry.getStatements()[0]?.getLeadingCommentRanges().map((r) => r.getText().replace(/^\/\/\s?/, "")).join(" "));
    containers.push({ id, entry, files });
    addNode({
      id,
      level: ["container"],
      kind: "container",
      name: isServer ? "KAGI server" : isCli ? `${file.split("/").at(-1)?.replace(/\.ts$/, "")} CLI` : file,
      technology: ["Bun", isServer ? "HTTP server" : isCli ? "CLI" : "", usesHono ? "Hono" : "", isServer && Bun.file(join(ROOT, "Dockerfile")).size > 0 ? "Docker" : ""].filter(Boolean).join(", "),
      ...((header || isServer) && { description: header || "Serves the door page, sign-in and the unlock API. One instance, no database." }),
      source: ev(entry.getStatements()[0] ?? entry, file),
    });
  }
  const server = containers.find((c) => /\bBun\.serve\(/.test(c.entry.getFullText()));
  const inContainer = (c: Container, n: Node) => c.files.has(n.getSourceFile().getFilePath());

  // ---- Wiring: where each factory is called, under which condition, into which slot --------------

  interface Binding {
    target: string;
    slots: Set<string>;
    condition?: string;
    evidence: Evidence;
    call: CallExpression;
  }
  const bindings: Binding[] = factoryCalls.map(({ call, target }) => {
    const slots = new Set<string>();
    let cur: Node | undefined = call;
    for (let depth = 0; cur && depth < 8; depth++, cur = cur.getParent()) {
      if (Node.isVariableDeclaration(cur)) slots.add(cur.getName());
      else if (Node.isPropertyAssignment(cur) || Node.isShorthandPropertyAssignment(cur)) slots.add(cur.getName());
      else if (Node.isBinaryExpression(cur) && cur.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
        const left = cur.getLeft();
        for (const id of [left, ...left.getDescendantsOfKind(SyntaxKind.Identifier)]) if (Node.isIdentifier(id)) slots.add(id.getText());
      }
      else if (Node.isBinaryExpression(cur) && cur.getLeft().getKind() === SyntaxKind.Identifier) slots.add(cur.getLeft().getText());
      if (Node.isStatement(cur) && !Node.isVariableStatement(cur) && !Node.isExpressionStatement(cur)) break;
    }
    const conds: string[] = [];
    let child: Node = call;
    for (let p = call.getParent(); p && !Node.isFunctionDeclaration(p); child = p, p = p.getParent()) {
      if (Node.isIfStatement(p)) {
        const c = p.getExpression().getText();
        conds.unshift(p.getThenStatement() === child ? c : `!(${c})`);
      } else if (Node.isConditionalExpression(p) && p.getCondition() !== child) {
        const c = p.getCondition().getText();
        conds.unshift(p.getWhenTrue() === child ? c : `!(${c})`);
      } else if (Node.isBinaryExpression(p) && p.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken && p.getRight() === child) {
        conds.unshift(`${p.getLeft().getText()} is unset`);
      }
    }
    return { target, slots, ...(conds.length && { condition: conds.join(" && ") }), evidence: ev(call), call };
  });

  // ---- Closure walk: what each component calls ----------------------------------------------------

  interface Usage {
    ports: Map<string, { methods: Set<string>; slots: Set<string>; evidence: Evidence[] }>;
    externals: Map<string, { label: Set<string>; evidence: Evidence[] }>;
    creates: Map<string, Evidence[]>;
  }
  const fnLike = (n: Node) => Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isMethodDeclaration(n) || Node.isConstructorDeclaration(n);
  /** The function a node belongs to, or its source file for top-level code. */
  const nearestFn = (n: Node) => n.getFirstAncestor((a) => fnLike(a) || Node.isSourceFile(a));
  function fnName(f: Node): string {
    if (Node.isSourceFile(f)) return "(module)";
    if (Node.isFunctionDeclaration(f)) return f.getName() ?? "(anonymous)";
    if (Node.isMethodDeclaration(f)) return `${f.getParentIfKind(SyntaxKind.ClassDeclaration)?.getName() ?? ""}.${f.getName()}`;
    if (Node.isConstructorDeclaration(f)) return `new ${f.getParentIfKind(SyntaxKind.ClassDeclaration)?.getName() ?? ""}`;
    const p = f.getParent();
    if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p))) return p.getName();
    if (p && Node.isCallExpression(p)) return `${p.getExpression().getText().split(".").at(-1)} callback`;
    return "(anonymous)";
  }
  /** Stable across edits elsewhere in the file (no line numbers), so models of two commits can be diffed. */
  const fnId = (f: Node) => {
    const chain: string[] = [];
    for (let cur: Node | undefined = f; cur; cur = cur.getParent()) if (fnLike(cur)) chain.unshift(fnName(cur));
    return `fn:${rel(f.getSourceFile().getFilePath())}:${chain.join(" › ")}`;
  };
  /** The name a port is reached through: `opts.authenticator.x` → authenticator, `api.x` → api (const api = opts.api). */
  function slotOf(expr: Node): string {
    if (Node.isPropertyAccessExpression(expr)) return expr.getName();
    if (Node.isIdentifier(expr)) {
      const d = declsOf(expr)[0];
      if (d && Node.isVariableDeclaration(d)) {
        const init = d.getInitializer();
        if (init && Node.isPropertyAccessExpression(init)) return init.getName();
      }
      return expr.getText();
    }
    return expr.getText();
  }

  /** Root function → the component it belongs to; a walk stops there instead of absorbing it. */
  const rootOwner = new Map<Node, string>();
  for (const comp of components.values()) for (const r of comp.roots) rootOwner.set(r, comp.id);

  function walk(c: Component): Usage {
    const usage: Usage = { ports: new Map(), externals: new Map(), creates: new Map() };
    /** Reaching another component's root: record it as a call to that component and stop. */
    const otherComponent = (n: Node, at: Node) => {
      const owner = rootOwner.get(n);
      if (!owner || owner === c.id) return false;
      usage.creates.set(owner, [...(usage.creates.get(owner) ?? []), ev(at)]);
      return true;
    };
    const view = `code:${c.id}`;
    const queue = [...c.roots];
    const seen = new Set<Node>();
    const ext = (sys: string, label: string, n: Node) => {
      const e = usage.externals.get(sys) ?? { label: new Set(), evidence: [] };
      e.label.add(label);
      e.evidence.push(ev(n));
      usage.externals.set(sys, e);
    };
    const codeNode = (f: Node) => {
      const id = fnId(f);
      addNode({ id, level: ["code"], kind: "function", name: fnName(f), technology: rel(f.getSourceFile().getFilePath()), source: ev(f, `${fnName(f)} (line ${f.getStartLineNumber()})`) });
      return id;
    };
    const codeEdge = (from: string, to: string, label: string, kind: MEdge["kind"], n: Node) => addEdge({ from, to, level: "code", view, label, kind, evidence: [ev(n)] });

    while (queue.length) {
      const f = queue.shift() as Node;
      if (seen.has(f)) continue;
      seen.add(f);
      const fid = codeNode(f);
      for (const d of f.getDescendants()) {
        if (nearestFn(d) !== f) continue;
        if (fnLike(d)) {
          if (rootOwner.has(d) && rootOwner.get(d) !== c.id) continue; // e.g. a route handler inside createKagiApp
          queue.push(d);
          codeEdge(fid, codeNode(d), "defines", "defines", d);
          continue;
        }
        if (Node.isStringLiteral(d) || Node.isNoSubstitutionTemplateLiteral(d)) {
          const host = /^https:\/\/([^/]+)/.exec(d.getLiteralText())?.[1];
          if (host) {
            ext(host, "HTTPS", d);
            addNode({ id: `ext:${host}`, level: ["code"], kind: "external", name: EXTERNAL_NAMES[host]?.name ?? host });
            codeEdge(fid, `ext:${host}`, "base URL", "uses", d);
          }
          continue;
        }
        if (Node.isPropertyAccessExpression(d)) {
          for (const decl of declsOf(d.getNameNode())) {
            const port = portOfDecl(decl);
            if (!port) continue;
            const u = usage.ports.get(port) ?? { methods: new Set(), slots: new Set(), evidence: [] };
            u.methods.add(d.getName());
            u.slots.add(slotOf(d.getExpression()));
            u.evidence.push(ev(d.getParent() ?? d));
            usage.ports.set(port, u);
            const iid = `port:${port}`;
            addNode({ id: iid, level: ["code"], kind: "interface", name: port, technology: PORTS_FILE, source: ev(decl.getParent() ?? decl, `interface ${port}`) });
            codeEdge(fid, iid, `${port}.${d.getName()}`, "calls", d);
          }
          if (d.getText() === "console.log") {
            ext("stdout", "console.log", d);
            addNode({ id: "ext:stdout", level: ["code"], kind: "external", name: EXTERNAL_NAMES.stdout?.name ?? "stdout" });
            codeEdge(fid, "ext:stdout", "console.log", "uses", d);
          }
          continue;
        }
        if (!Node.isCallExpression(d) && !Node.isNewExpression(d)) continue;
        const callee = d.getExpression();
        const nameNode = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
        for (const decl of declsOf(nameNode)) {
          const lib = libraryOf(decl);
          if (lib) {
            const fname = nameNode.getText();
            const net = NETWORK_CALLS[lib];
            const lid = `lib:${lib}`;
            addNode({ id: lid, level: ["code"], kind: "library", name: lib, technology: "npm" });
            codeEdge(fid, lid, fname, "calls", d);
            if (net?.fns.includes(fname)) ext(net.system, `${lib}.${fname}`, d);
            if (Node.isIdentifier(nameNode) && /^(fetch|doFetch)$/.test(fname)) ext("configured-http", "fetch", d);
            continue;
          }
          if (!inWorkspace(decl)) continue;
          if (Node.isFunctionDeclaration(decl) && factoryDecls.has(decl) && !c.roots.includes(decl)) {
            const target = factoryDecls.get(decl) as string;
            usage.creates.set(target, [...(usage.creates.get(target) ?? []), ev(d)]);
            continue;
          }
          if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
            if (otherComponent(decl, d)) continue; // e.g. main.ts calling loadConfig()
            queue.push(decl);
            codeEdge(fid, codeNode(decl), "calls", "calls", d);
          } else if (Node.isVariableDeclaration(decl)) {
            const init = decl.getInitializer();
            if (init && fnLike(init)) {
              queue.push(init);
              codeEdge(fid, codeNode(init), "calls", "calls", d);
            }
          } else if (Node.isClassDeclaration(decl)) {
            const ctor = decl.getConstructors()[0];
            if (ctor) {
              queue.push(ctor);
              codeEdge(fid, codeNode(ctor), "new", "calls", d);
            }
          } else if ((Node.isParameterDeclaration(decl) || Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl)) && /\btypeof fetch\b|=> Promise<Response>/.test(decl.getType().getText(decl))) {
            ext("configured-http", "fetch", d);
          }
        }
      }
    }
    // fetch to a configured URL counts as its own external only when nothing more specific was found
    if (usage.externals.has("configured-http") && usage.externals.size > 1) usage.externals.delete("configured-http");
    return usage;
  }

  // ---- Assemble views ---------------------------------------------------------------------------

  if (!server) throw new Error("no HTTP server entry found");
  const usages = new Map([...components].map(([id, c]) => [id, walk(c)] as const));
  const componentsIn = (ctr: Container) =>
    [...components.values()].filter((c) => c.roots.some((r) => inContainer(ctr, r)) && (c.group === "route" || c.group === "config" || bindings.some((b) => b.target === c.id && inContainer(ctr, b.call))));

  // L3: KAGI server components
  const serverView = `components:${server.id}`;
  const serverComponents = componentsIn(server);
  for (const c of serverComponents) addNode({ ...c.node, parent: server.id });
  for (const c of serverComponents) {
    const u = usages.get(c.id) as Usage;
    for (const [port, pu] of u.ports) {
      const impls = serverComponents.filter((x) => x.group === port && x.id !== c.id);
      const bySlot = impls.filter((x) => bindings.some((b) => b.target === x.id && inContainer(server, b.call) && [...pu.slots].some((s) => b.slots.has(s))));
      for (const impl of bySlot.length ? bySlot : impls) {
        const conds = bindings.filter((b) => b.target === impl.id && inContainer(server, b.call) && b.condition).map((b) => b.condition as string);
        addEdge({ from: c.id, to: impl.id, level: "component", view: serverView, label: [...pu.methods].map((m) => `${port}.${m}`).join(", "), kind: "uses", ...(conds.length && { condition: [...new Set(conds)].join(" | ") }), evidence: pu.evidence });
      }
    }
    for (const [target, evs] of u.creates) {
      if (!serverComponents.some((x) => x.id === target)) continue;
      const cond = bindings.filter((b) => b.target === target && evs.some((e) => e.file === b.evidence.file && e.line === b.evidence.line) && b.condition).map((b) => b.condition as string);
      const label = components.get(target)?.group === "config" ? "calls" : "creates";
      addEdge({ from: c.id, to: target, level: "component", view: serverView, label, kind: "wires", ...(cond.length && { condition: [...new Set(cond)].join(" | ") }), evidence: evs });
    }
    for (const [sys, e] of u.externals) {
      const id = `ext:${sys}`;
      const meta = EXTERNAL_NAMES[sys];
      addNode({ id, level: ["component", "container", "context"], kind: "external", name: meta?.name ?? sys, ...(meta && { technology: meta.tech, description: meta.description }) });
      addEdge({ from: c.id, to: id, level: "component", view: serverView, label: [...e.label].join(", "), kind: "uses", evidence: e.evidence });
    }
  }
  for (const c of components.values()) {
    addNode({ ...c.node, level: [...new Set([...(nodes.get(c.id)?.level ?? []), "component" as Level])] });
    // L4 root: the component itself stands for its first root function in the code view
    for (const r of c.roots) addEdge({ from: c.id, to: fnId(r), level: "code", view: `code:${c.id}`, label: "is", kind: "defines", evidence: [ev(r, fnName(r))] });
  }

  // L2: containers → externals (aggregated from their components)
  const sysId = "sys:kagi";
  for (const ctr of containers) {
    const n = nodes.get(ctr.id) as MNode;
    n.parent = sysId;
    for (const c of componentsIn(ctr)) {
      for (const [sys, e] of (usages.get(c.id) as Usage).externals) {
        const id = `ext:${sys}`;
        const meta = EXTERNAL_NAMES[sys];
        addNode({ id, level: ["container", "context"], kind: "external", name: meta?.name ?? sys, ...(meta && { technology: meta.tech, description: meta.description }) });
        // At this zoom level name the library, not each function (openid-client.discovery → openid-client)
        const pkg = (l: string) => Object.keys(NETWORK_CALLS).find((p) => l.startsWith(`${p}.`)) ?? l;
        const label = [...new Set([...e.label].map(pkg))].join(", ");
        addEdge({ from: ctr.id, to: id, level: "container", view: "containers", label, kind: "uses", evidence: e.evidence });
      }
    }
  }

  // L1: the system as a whole
  addNode({ id: sysId, level: ["context", "container"], kind: "system", name: "KAGI", technology: "Keyless Access Gate Interface", description: "Unlocks a door after a tap on an NFC tag, a sign-in and one button press." });
  for (const e of edges.filter((x) => x.view === "containers")) addEdge({ ...e, from: sysId, level: "context", view: "context" });

  // ---- Hand-added: who is outside the code ------------------------------------------------------

  const manual = (n: Omit<MNode, "manual">) => addNode({ ...n, manual: true });
  const manualEdge = (e: Omit<MEdge, "manual" | "evidence">) => addEdge({ ...e, manual: true, evidence: [] });
  manual({ id: "person:user", level: ["context", "container", "component"], kind: "person", name: "Person at the door", description: "Taps the NFC tag with a phone, signs in, presses Unlock." });
  manual({ id: "person:admin", level: ["context", "container"], kind: "person", name: "Administrator", description: "Puts people in door groups at the identity provider; configures KAGI." });
  manual({ id: "ext:apps", level: ["context", "container", "component"], kind: "external", name: "Other apps", technology: "e.g. HCM", description: "Unlock on a signed-in user's behalf with a bearer JWT." });
  manual({ id: "ext:locks", level: ["context", "container"], kind: "external", name: "Smart locks", technology: "SESAME 5, SwitchBot Lock Pro", description: "The physical locks, reached only through their vendor's cloud and hub." });
  const routes = serverComponents.filter((c) => c.group === "route");
  const route = (re: RegExp) => routes.filter((r) => re.test(r.node.name));
  for (const r of route(/^(GET|POST) \/d\/|^\* \/auth\//)) manualEdge({ from: "person:user", to: r.id, level: "component", view: serverView, label: "HTTPS (browser)", kind: "uses" });
  for (const r of route(/\/api\//)) manualEdge({ from: "ext:apps", to: r.id, level: "component", view: serverView, label: "HTTPS + bearer JWT", kind: "uses" });
  manualEdge({ from: "person:user", to: server.id, level: "container", view: "containers", label: "door page, sign-in", kind: "uses" });
  manualEdge({ from: "ext:apps", to: server.id, level: "container", view: "containers", label: "unlock API", kind: "uses" });
  manualEdge({ from: "person:admin", to: "ext:oidc", level: "container", view: "containers", label: "manages door groups", kind: "uses" });
  for (const v of ["containers", "context"] as const) {
    for (const sys of ["ext:app.candyhouse.co", "ext:api.switch-bot.com"]) if (nodes.has(sys)) manualEdge({ from: sys, to: "ext:locks", level: v === "context" ? "context" : "container", view: v, label: "via hub", kind: "uses" });
  }
  manualEdge({ from: "person:user", to: sysId, level: "context", view: "context", label: "tap, sign in, unlock", kind: "uses" });
  manualEdge({ from: "ext:apps", to: sysId, level: "context", view: "context", label: "unlock API", kind: "uses" });
  manualEdge({ from: "person:admin", to: "ext:oidc", level: "context", view: "context", label: "manages door groups", kind: "uses" });
  manualEdge({ from: "person:user", to: "ext:oidc", level: "context", view: "context", label: "signs in (passkey)", kind: "uses" });

  // ---- Views ------------------------------------------------------------------------------------

  const views = [
    { id: "context", level: "context", title: "System context", subject: sysId },
    { id: "containers", level: "container", title: "Containers", subject: sysId },
    { id: serverView, level: "component", title: "KAGI server: components", subject: server.id },
    ...[...components.values()].map((c) => ({ id: `code:${c.id}`, level: "code", title: `Code: ${c.node.name}`, subject: c.id })),
  ];
  const viewNodes = (vid: string) => {
    const ids = new Set(edges.filter((e) => e.view === vid).flatMap((e) => [e.from, e.to]));
    if (vid === "context") ids.add(sysId);
    if (vid === "containers") for (const c of containers) ids.add(c.id);
    if (vid === serverView) for (const c of serverComponents) ids.add(c.id);
    return [...ids].filter((id) => nodes.has(id));
  };

  const model: Model = {
    generatedFrom: "",
    repository: "https://github.com/misonikomipan/KAGI",
    ports: [...ports.keys()],
    nodes: [...nodes.values()],
    edges,
    views: views.map((v) => ({ ...v, nodes: viewNodes(v.id) })),
  };
  return model;
}
