import { parseGithubOwnerRepo } from "@/lib/validate";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "DemoBro.video (repo-ingest; +https://demobro.video)";

export type RepoIngestOk = {
  status: "ok";
  owner: string;
  repo: string;
  title: string;
  description: string;
  badges: string[];
  raw: {
    name: string;
    description: string | null;
    homepage: string | null;
    defaultBranch: string;
    readmeExcerpt: string;
    languages: Record<string, number>;
    packageJson: {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } | null;
    treePaths: string[];
  };
};

export type RepoIngestFallback = {
  status: "fallback";
  reason: "not_found" | "private" | "rate_limited" | "error";
  message: string;
  needsManualTitle: true;
  suggestedTitle: string;
  owner?: string;
  repo?: string;
};

export type RepoIngestResult = RepoIngestOk | RepoIngestFallback;

type GithubRepo = {
  name: string;
  full_name: string;
  description: string | null;
  homepage: string | null;
  default_branch: string;
  private: boolean;
  language: string | null;
};

type GithubContentFile = {
  type: string;
  encoding?: string;
  content?: string;
  path?: string;
};

type GithubTreeResponse = {
  tree?: Array<{ path: string; type: string }>;
  truncated?: boolean;
};

const DEP_BADGES: Array<{ match: RegExp; label: string }> = [
  { match: /^next$/, label: "Next.js" },
  { match: /^vite$/, label: "Vite" },
  { match: /^react$/, label: "React" },
  { match: /^react-dom$/, label: "React" },
  { match: /^vue$/, label: "Vue" },
  { match: /^nuxt$/, label: "Nuxt" },
  { match: /^svelte$/, label: "Svelte" },
  { match: /^@sveltejs\/kit$/, label: "SvelteKit" },
  { match: /^angular$/, label: "Angular" },
  { match: /^@angular\/core$/, label: "Angular" },
  { match: /^express$/, label: "Express" },
  { match: /^fastify$/, label: "Fastify" },
  { match: /^hono$/, label: "Hono" },
  { match: /^typescript$/, label: "TypeScript" },
  { match: /^tailwindcss$/, label: "Tailwind" },
  { match: /^prisma$/, label: "Prisma" },
  { match: /^drizzle-orm$/, label: "Drizzle" },
  { match: /^@supabase\//, label: "Supabase" },
  { match: /^firebase$/, label: "Firebase" },
  { match: /^three$/, label: "Three.js" },
  { match: /^@tensorflow\//, label: "TensorFlow" },
  { match: /^openai$/, label: "OpenAI" },
  { match: /^zod$/, label: "Zod" },
  { match: /^playwright$/, label: "Playwright" },
];

const TREE_BADGES: Array<{ match: RegExp; label: string }> = [
  { match: /^Cargo\.toml$/, label: "Rust" },
  { match: /^go\.mod$/, label: "Go" },
  { match: /^requirements\.txt$/, label: "Python" },
  { match: /^pyproject\.toml$/, label: "Python" },
  { match: /^Gemfile$/, label: "Ruby" },
  { match: /^composer\.json$/, label: "PHP" },
  { match: /^Dockerfile$/, label: "Docker" },
  { match: /^docker-compose\.ya?ml$/, label: "Docker" },
];

async function githubFetch(
  path: string,
): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 403 || res.status === 429) {
    const text = await res.text();
    const rateLimited =
      remaining === "0" ||
      /rate limit/i.test(text) ||
      res.status === 429;
    if (rateLimited) {
      return { res, body: { __rateLimited: true } };
    }
  }

  let body: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  return { res, body };
}

function humanizeRepoName(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstReadmeParagraph(readme: string): string | null {
  const lines = readme
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim());

  const chunks: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (!line) {
      if (collecting && chunks.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^```/.test(line)) break;
    if (/^[-*+]\s/.test(line)) continue;
    if (/^!\[/.test(line)) continue;
    if (/^\[.*\]:/.test(line)) continue;

    collecting = true;
    chunks.push(line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, ""));
    if (chunks.join(" ").length > 160) break;
  }

  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
}

/**
 * Plenty of READMEs open with setup instructions rather than the product name,
 * and the first heading then becomes the on-screen title and "Meet …" caption.
 * A title is a name, so reject headings that read as an instruction or a
 * standard section header.
 */
const SECTION_HEADING =
  /^(clone|install|installing|installation|getting[ -]started|get[ -]started|set[ -]?up|setup|usage|how[ -]to|quick[ -]?start|introduction|intro|overview|about|features|prerequisites|requirements|contributing|contribution|license|licence|changelog|roadmap|documentation|docs|deploy|deployment|running|run|build|building|test|testing|development|env|configuration|config|todo|credits|acknowledgements|table of contents|contents)\b/i;

function readmeTitle(readme: string): string | null {
  // Shell comments inside fenced examples ("# Clone the repository", "# or")
  // are indistinguishable from an H1 by regex and are the most common source of
  // a nonsense project title, so drop fenced blocks before looking.
  const prose = readme
    .replace(/^ {0,3}```[\s\S]*?^ {0,3}```/gm, "")
    .replace(/^ {0,3}~~~[\s\S]*?^ {0,3}~~~/gm, "");
  const match = prose.match(/^#\s+(.+)$/m);
  if (!match) return null;
  const heading = match[1]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!heading) return null;
  if (SECTION_HEADING.test(heading)) return null;
  // Product names are short; a long heading is a sentence, not a name.
  if (heading.split(/\s+/).length > 6) return null;
  return heading;
}

function decodeReadme(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const file = body as GithubContentFile;
  if (file.encoding === "base64" && typeof file.content === "string") {
    try {
      return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
        "utf8",
      );
    } catch {
      return "";
    }
  }
  return "";
}

function parsePackageJson(body: unknown): RepoIngestOk["raw"]["packageJson"] {
  if (!body || typeof body !== "object") return null;
  const file = body as GithubContentFile;
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return null;
  }
  try {
    const text = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
      "utf8",
    );
    const json = JSON.parse(text) as RepoIngestOk["raw"]["packageJson"];
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

function deriveBadges(
  languages: Record<string, number>,
  packageJson: RepoIngestOk["raw"]["packageJson"],
  treePaths: string[],
): string[] {
  const badges: string[] = [];
  const push = (label: string) => {
    if (!badges.includes(label) && badges.length < 5) badges.push(label);
  };

  const langEntries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  for (const [lang] of langEntries) {
    if (lang === "CSS" || lang === "HTML" || lang === "SCSS") continue;
    push(lang);
    if (badges.length >= 3) break;
  }

  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  for (const dep of Object.keys(deps)) {
    for (const rule of DEP_BADGES) {
      if (rule.match.test(dep)) push(rule.label);
    }
  }

  const basenames = treePaths.map((p) => p.split("/").pop() ?? p);
  for (const name of basenames) {
    for (const rule of TREE_BADGES) {
      if (rule.match.test(name)) push(rule.label);
    }
  }

  if (badges.length === 0 && langEntries[0]) {
    push(langEntries[0][0]);
  }

  return badges.slice(0, 5);
}

function deriveTitle(
  repo: GithubRepo,
  packageJson: RepoIngestOk["raw"]["packageJson"],
  readme: string,
): string {
  const fromReadme = readmeTitle(readme);
  if (fromReadme && fromReadme.length <= 60) return fromReadme;

  if (packageJson?.name && !packageJson.name.startsWith("@")) {
    return humanizeRepoName(packageJson.name);
  }

  return humanizeRepoName(repo.name);
}

function deriveDescription(
  repo: GithubRepo,
  packageJson: RepoIngestOk["raw"]["packageJson"],
  readme: string,
): string {
  if (repo.description?.trim()) return repo.description.trim();
  if (packageJson?.description?.trim()) return packageJson.description.trim();
  const fromReadme = firstReadmeParagraph(readme);
  if (fromReadme) return fromReadme;
  return `A project built from ${repo.full_name}.`;
}

function fallbackResult(
  reason: RepoIngestFallback["reason"],
  message: string,
  owner?: string,
  repo?: string,
): RepoIngestFallback {
  return {
    status: "fallback",
    reason,
    message,
    needsManualTitle: true,
    suggestedTitle: repo ? humanizeRepoName(repo) : "Untitled project",
    owner,
    repo,
  };
}

export async function ingestGithubRepo(
  githubUrl: string,
): Promise<RepoIngestResult> {
  const parsed = parseGithubOwnerRepo(githubUrl);
  if (!parsed) {
    return fallbackResult(
      "error",
      "That doesn’t look like a GitHub repo URL.",
    );
  }

  const { owner, repo } = parsed;
  const { res, body } = await githubFetch(`/repos/${owner}/${repo}`);

  if (
    body &&
    typeof body === "object" &&
    "__rateLimited" in (body as object)
  ) {
    return fallbackResult(
      "rate_limited",
      "GitHub rate limit hit — enter a title manually and continue.",
      owner,
      repo,
    );
  }

  if (res.status === 404) {
    return fallbackResult(
      "not_found",
      "That repo doesn’t exist (or isn’t public).",
      owner,
      repo,
    );
  }

  if (res.status === 401 || res.status === 403) {
    return fallbackResult(
      "private",
      "That repo is private — enter a title manually and continue.",
      owner,
      repo,
    );
  }

  if (!res.ok) {
    return fallbackResult(
      "error",
      `GitHub returned ${res.status}. Enter a title manually and continue.`,
      owner,
      repo,
    );
  }

  const repoMeta = body as GithubRepo;
  if (repoMeta.private) {
    return fallbackResult(
      "private",
      "That repo is private — enter a title manually and continue.",
      owner,
      repo,
    );
  }

  const [readmeRes, languagesRes, packageRes, treeRes] = await Promise.all([
    githubFetch(`/repos/${owner}/${repo}/readme`),
    githubFetch(`/repos/${owner}/${repo}/languages`),
    githubFetch(`/repos/${owner}/${repo}/contents/package.json`),
    githubFetch(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(repoMeta.default_branch)}?recursive=1`,
    ),
  ]);

  if (
    [readmeRes, languagesRes, packageRes, treeRes].some(
      ({ body: b }) =>
        b && typeof b === "object" && "__rateLimited" in (b as object),
    )
  ) {
    return fallbackResult(
      "rate_limited",
      "GitHub rate limit hit mid-ingest — enter a title manually and continue.",
      owner,
      repo,
    );
  }

  const readme = readmeRes.res.ok ? decodeReadme(readmeRes.body) : "";
  const languages =
    languagesRes.res.ok &&
    languagesRes.body &&
    typeof languagesRes.body === "object"
      ? (languagesRes.body as Record<string, number>)
      : {};
  const packageJson = packageRes.res.ok
    ? parsePackageJson(packageRes.body)
    : null;

  const treeBody = treeRes.body as GithubTreeResponse;
  const treePaths =
    treeRes.res.ok && Array.isArray(treeBody.tree)
      ? treeBody.tree
          .filter((n) => n.type === "blob" && typeof n.path === "string")
          .map((n) => n.path)
          .slice(0, 400)
      : [];

  const title = deriveTitle(repoMeta, packageJson, readme);
  const description = deriveDescription(repoMeta, packageJson, readme);
  const badges = deriveBadges(languages, packageJson, treePaths);

  return {
    status: "ok",
    owner,
    repo,
    title,
    description,
    badges,
    raw: {
      name: repoMeta.name,
      description: repoMeta.description,
      homepage: repoMeta.homepage,
      defaultBranch: repoMeta.default_branch,
      readmeExcerpt: readme.slice(0, 1200),
      languages,
      packageJson,
      treePaths: treePaths.slice(0, 80),
    },
  };
}
