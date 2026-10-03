const BOT_NAME =
  "RetroInternetBot/1.0 (+https://retro-internet.alan-cyber-u.workers.dev/)";

const MAX_HTML_BYTES = 300_000;
const MAX_INDEX_TEXT = 40_000;
const MAX_LINKS_PER_PAGE = 30;
const MAX_SITEMAP_LINKS = 50;
const MAX_DEPTH = 2;
const RECRAWL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_DELAY_MS = 15_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/api/status") {
        return withCors(await apiStatus(env));
      }

      if (url.pathname === "/api/search") {
        return withCors(await apiSearch(url, env));
      }

      return new Response(
        "Retro Internet Search API is online!",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        }
      );
    } catch (error) {
      console.error(error);

      return withCors(
        json(
          {
            error: "Внутренняя ошибка API",
            details: String(error?.message || error)
          },
          500
        )
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(crawlOne(env));
  }
};


// ============================================================
// STATUS
// ============================================================

async function apiStatus(env) {
  const pages = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM pages")
    .first("n");

  const queue = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM crawl_queue")
    .first("n");

  const pending = await env.DB
    .prepare(
      "SELECT COUNT(*) AS n FROM crawl_queue WHERE status = 'pending'"
    )
    .first("n");

  return json({
    ok: true,
    name: "Retro Internet Search API",
    indexed_pages: Number(pages || 0),
    queued_urls: Number(queue || 0),
    pending_urls: Number(pending || 0),
    search_index: "D1 FTS5",
    external_search_api: false,
    crawler: "Cloudflare Worker Cron",
    message:
      "Собственный индекс Retro Internet. Google, Bing и Brave не используются."
  });
}


// ============================================================
// SEARCH API
// ============================================================

async function apiSearch(url, env) {
  const query = (url.searchParams.get("q") || "").trim();

  if (!query) {
    return json(
      {
        error: "Введите запрос"
      },
      400
    );
  }

  let limit = Number(url.searchParams.get("limit") || 10);

  if (!Number.isFinite(limit)) {
    limit = 10;
  }

  limit = Math.max(1, Math.min(20, Math.floor(limit)));

  const words =
    query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 8) || [];

  if (!words.length) {
    return json({
      query,
      results: [],
      total: 0,
      index: "Retro Internet"
    });
  }

  // Безопасный запрос FTS5.
  const match = words
    .map(word => `"${word.replaceAll('"', '""')}"`)
    .join(" AND ");

  const result = await env.DB
    .prepare(`
      SELECT
        page_id,
        title,
        url,
        description,
        substr(content, 1, 400) AS excerpt,
        bm25(
          pages_fts,
          5.0,
          2.0,
          1.0
        ) AS rank
      FROM pages_fts
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
    .bind(match, limit)
    .all();

  const rows = result.results || [];

  return json({
    query,
    total: rows.length,
    index: "Retro Internet",
    results: rows.map(row => ({
      title: row.title || row.url,
      url: row.url,
      description:
        row.description ||
        row.excerpt ||
        ""
    }))
  });
}


// ============================================================
// CRAWLER
// ============================================================

async function crawlOne(env) {
  const job = await env.DB
    .prepare(`
      SELECT
        id,
        url,
        depth,
        attempts
      FROM crawl_queue
      WHERE status = 'pending'
        AND next_at <= ?
      ORDER BY next_at ASC, id ASC
      LIMIT 1
    `)
    .bind(Date.now())
    .first();

  if (!job) {
    return;
  }

  const jobId = Number(job.id);
  const targetUrl = String(job.url);
  const depth = Number(job.depth || 0);
  const attempts = Number(job.attempts || 0);

  await env.DB
    .prepare(`
      UPDATE crawl_queue
      SET status = 'working',
          last_error = NULL
      WHERE id = ?
    `)
    .bind(jobId)
    .run();

  try {
    const page = new URL(targetUrl);
    const host = page.hostname.toLowerCase();

    const wait = await getHostWait(env, host);

    if (wait > 0) {
      await env.DB
        .prepare(`
          UPDATE crawl_queue
          SET status = 'pending',
              next_at = ?
          WHERE id = ?
        `)
        .bind(Date.now() + wait, jobId)
        .run();

      return;
    }

    const result = await crawlPage(
      env,
      targetUrl,
      depth
    );

    await env.DB
      .prepare(
        "DELETE FROM crawl_queue WHERE id = ?"
      )
      .bind(jobId)
      .run();

    if (result.indexed) {
      await enqueueUrl(
        env,
        targetUrl,
        depth,
        Date.now() + RECRAWL_MS
      );
    }
  } catch (error) {
    const nextAttempts = attempts + 1;

    const backoff = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(
        5 * 60 * 1000,
        2 ** Math.min(nextAttempts, 8) * 60 * 1000
      )
    );

    await env.DB
      .prepare(`
        UPDATE crawl_queue
        SET status = 'pending',
            attempts = ?,
            next_at = ?,
            last_error = ?
        WHERE id = ?
      `)
      .bind(
        nextAttempts,
        Date.now() + backoff,
        String(
          error?.message || error
        ).slice(0, 500),
        jobId
      )
      .run();
  }
}


// ============================================================
// FETCH PAGE
// ============================================================

async function crawlPage(
  env,
  rawUrl,
  depth
) {
  const pageUrl = normalizeUrl(rawUrl);

  if (!pageUrl) {
    throw new Error("bad_url");
  }

  if (depth > MAX_DEPTH) {
    throw new Error("max_depth");
  }

  const page = new URL(pageUrl);

  // robots.txt
  const allowed = await allowedByRobots(
    env,
    page
  );

  if (!allowed) {
    throw new Error("robots_disallow");
  }

  // Последняя версия страницы.
  const existing = await env.DB
    .prepare(`
      SELECT
        id,
        etag,
        last_modified
      FROM pages
      WHERE url = ?
      LIMIT 1
    `)
    .bind(pageUrl)
    .first();

  const headers = {
    "User-Agent": BOT_NAME,
    "Accept":
      "text/html,application/xhtml+xml,text/plain,*/*;q=0.1"
  };

  if (existing?.etag) {
    headers["If-None-Match"] =
      existing.etag;
  }

  if (existing?.last_modified) {
    headers["If-Modified-Since"] =
      existing.last_modified;
  }

  const response = await fetch(
    pageUrl,
    {
      method: "GET",
      headers,
      redirect: "follow"
    }
  );

  await setHostNext(
    env,
    page.hostname,
    Date.now() + HOST_DELAY_MS
  );

  if (
    response.status === 304 &&
    existing
  ) {
    await env.DB
      .prepare(`
        UPDATE pages
        SET fetched_at = ?,
            status_code = 304
        WHERE id = ?
      `)
      .bind(
        Date.now(),
        existing.id
      )
      .run();

    return {
      indexed: true,
      discovered: 0
    };
  }

  if (!response.ok) {
    throw new Error(
      `http_${response.status}`
    );
  }

  const contentType = (
    response.headers.get(
      "content-type"
    ) || ""
  ).toLowerCase();

  const contentLength = Number(
    response.headers.get(
      "content-length"
    ) || 0
  );

  if (
    contentLength &&
    contentLength > MAX_HTML_BYTES
  ) {
    throw new Error("too_large");
  }

  const body =
    await response.text();

  if (
    body.length > MAX_HTML_BYTES
  ) {
    throw new Error("too_large");
  }

  // sitemap.xml / XML
  if (
    contentType.includes("xml") ||
    contentType.includes("rss") ||
    contentType.includes("atom")
  ) {
    let discovered = 0;

    for (
      const link of extractXmlLinks(body)
        .slice(0, MAX_SITEMAP_LINKS)
    ) {
      const normalized =
        normalizeUrl(link);

      if (!normalized) {
        continue;
      }

      if (
        depth < MAX_DEPTH &&
        await enqueueUrl(
          env,
          normalized,
          depth + 1,
          Date.now()
        )
      ) {
        discovered++;
      }
    }

    return {
      indexed: false,
      discovered
    };
  }

  // Индексируем HTML.
  if (
    !contentType.includes("text/html") &&
    !contentType.includes(
      "application/xhtml+xml"
    ) &&
    !contentType.includes("text/plain") &&
    contentType !== ""
  ) {
    throw new Error("not_html");
  }

  const extracted =
    extractHtml(
      body,
      pageUrl
    );

  const title =
    extracted.title ||
    page.hostname;

  const description =
    extracted.description ||
    extracted.text.slice(0, 500);

  const content =
    extracted.text.slice(
      0,
      MAX_INDEX_TEXT
    );

  const now = Date.now();

  let pageId = existing?.id;

  if (pageId) {
    await env.DB
      .prepare(`
        UPDATE pages
        SET
          title = ?,
          description = ?,
          content = ?,
          fetched_at = ?,
          status_code = ?,
          etag = ?,
          last_modified = ?
        WHERE id = ?
      `)
      .bind(
        title,
        description,
        content,
        now,
        response.status,
        response.headers.get("etag"),
        response.headers.get(
          "last-modified"
        ),
        pageId
      )
      .run();

    await env.DB
      .prepare(`
        DELETE FROM pages_fts
        WHERE page_id = ?
      `)
      .bind(pageId)
      .run();
  } else {
    const inserted =
      await env.DB
        .prepare(`
          INSERT INTO pages (
            url,
            title,
            description,
            content,
            fetched_at,
            status_code,
            etag,
            last_modified
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          pageUrl,
          title,
          description,
          content,
          now,
          response.status,
          response.headers.get("etag"),
          response.headers.get(
            "last-modified"
          )
        )
        .run();

    pageId =
      inserted.meta?.last_row_id;
  }

  // Добавляем документ в FTS5.
  await env.DB
    .prepare(`
      INSERT INTO pages_fts (
        title,
        description,
        content,
        url,
        page_id
      )
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      title,
      description,
      content,
      pageUrl,
      pageId
    )
    .run();

  let discovered = 0;

  // Обходим ссылки.
  if (depth < MAX_DEPTH) {
    for (
      const link of extracted.links
        .slice(0, MAX_LINKS_PER_PAGE)
    ) {
      if (
        await enqueueUrl(
          env,
          link,
          depth + 1,
          Date.now()
        )
      ) {
        discovered++;
      }
    }

    // Пытаемся найти sitemap.
    if (depth === 0) {
      await enqueueUrl(
        env,
        `${page.origin}/sitemap.xml`,
        1,
        Date.now()
      );
    }
  }

  return {
    indexed: true,
    discovered
  };
}


// ============================================================
// HTML PARSER
// ============================================================

function extractHtml(
  html,
  baseUrl
) {
  const titleMatch =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  const title =
    decodeEntities(
      titleMatch?.[1] || ""
    ).trim();

  let description = "";

  const meta1 =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
    );

  const meta2 =
    html.match(
      /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
    );

  description = decodeEntities(
    meta1?.[1] ||
    meta2?.[1] ||
    ""
  ).trim();

  const text =
    decodeEntities(
      html
        .replace(
          /<!--[\s\S]*?-->/g,
          " "
        )
        .replace(
          /<(script|style|noscript|template|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi,
          " "
        )
        .replace(
          /<[^>]+>/g,
          " "
        )
    )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const links = [];
  const seen = new Set();

  const linkRegex =
    /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;

  let match;

  while (
    (match = linkRegex.exec(html)) &&
    links.length < MAX_LINKS_PER_PAGE
  ) {
    try {
      const target =
        new URL(
          match[1],
          baseUrl
        );

      if (
        target.protocol !== "http:" &&
        target.protocol !== "https:"
      ) {
        continue;
      }

      target.hash = "";

      const normalized =
        normalizeUrl(
          target.href
        );

      if (
        normalized &&
        !seen.has(normalized)
      ) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch {
      // плохая ссылка
    }
  }

  return {
    title,
    description,
    text,
    links
  };
}


// ============================================================
// XML / SITEMAP
// ============================================================

function extractXmlLinks(xml) {
  const result = [];

  const regex =
    /<loc[^>]*>([\s\S]*?)<\/loc>/gi;

  let match;

  while (
    (match = regex.exec(xml)) &&
    result.length < MAX_SITEMAP_LINKS
  ) {
    result.push(
      decodeEntities(
        match[1].trim()
      )
    );
  }

  return result;
}


// ============================================================
// QUEUE
// ============================================================

async function enqueueUrl(
  env,
  rawUrl,
  depth,
  nextAt
) {
  const url =
    normalizeUrl(rawUrl);

  if (!url) {
    return false;
  }

  if (depth > MAX_DEPTH) {
    return false;
  }

  const existing =
    await env.DB
      .prepare(`
        SELECT id
        FROM crawl_queue
        WHERE url = ?
        LIMIT 1
      `)
      .bind(url)
      .first();

  if (existing) {
    return false;
  }

  const count =
    await env.DB
      .prepare(`
        SELECT COUNT(*) AS n
        FROM crawl_queue
        WHERE status IN ('pending', 'working')
      `)
      .first("n");

  if (Number(count || 0) >= 50000) {
    return false;
  }

  await env.DB
    .prepare(`
      INSERT INTO crawl_queue (
        url,
        depth,
        status,
        next_at,
        attempts
      )
      VALUES (?, ?, 'pending', ?, 0)
    `)
    .bind(
      url,
      depth,
      nextAt
    )
    .run();

  return true;
}


// ============================================================
// ROBOTS.TXT
// ============================================================

async function allowedByRobots(
  env,
  page
) {
  const host =
    page.hostname.toLowerCase();

  const cached =
    await env.DB
      .prepare(`
        SELECT body, fetched_at
        FROM robots
        WHERE host = ?
        LIMIT 1
      `)
      .bind(host)
      .first();

  let robotsText =
    cached?.body || "";

  const stale =
    !cached ||
    Date.now() -
      Number(
        cached.fetched_at || 0
      ) >
      24 * 60 * 60 * 1000;

  if (stale) {
    try {
      const response =
        await fetch(
          `${page.origin}/robots.txt`,
          {
            headers: {
              "User-Agent":
                BOT_NAME
            }
          }
        );

      robotsText =
        response.ok
          ? (
              await response.text()
            ).slice(0, 100000)
          : "";
    } catch {
      robotsText = "";
    }

    await env.DB
      .prepare(`
        INSERT INTO robots (
          host,
          body,
          fetched_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(host)
        DO UPDATE SET
          body = excluded.body,
          fetched_at = excluded.fetched_at
      `)
      .bind(
        host,
        robotsText,
        Date.now()
      )
      .run();
  }

  if (!robotsText) {
    return true;
  }

  return robotsAllows(
    robotsText,
    BOT_NAME,
    page.pathname
  );
}


function robotsAllows(
  text,
  agent,
  path
) {
  const lines =
    text.split(/\r?\n/);

  let agents = [];
  let rules = [];

  const groups = [];

  for (const raw of lines) {
    const line =
      raw
        .replace(/#.*/, "")
        .trim();

    if (!line) {
      continue;
    }

    const pos =
      line.indexOf(":");

    if (pos < 0) {
      continue;
    }

    const key =
      line
        .slice(0, pos)
        .trim()
        .toLowerCase();

    const value =
      line
        .slice(pos + 1)
        .trim();

    if (key === "user-agent") {
      if (
        agents.length ||
        rules.length
      ) {
        groups.push({
          agents,
          rules
        });
      }

      agents = [
        value.toLowerCase()
      ];

      rules = [];
    }

    if (
      key === "allow" ||
      key === "disallow"
    ) {
      rules.push({
        type: key,
        value
      });
    }
  }

  if (
    agents.length ||
    rules.length
  ) {
    groups.push({
      agents,
      rules
    });
  }

  const bot =
    agent
      .toLowerCase()
      .split("/")[0];

  const matching =
    groups.filter(group =>
      group.agents.includes("*") ||
      group.agents.some(
        item =>
          bot.startsWith(item)
      )
    );

  if (!matching.length) {
    return true;
  }

  const rulesForBot =
    matching.flatMap(
      group => group.rules
    );

  let best = null;

  for (const rule of rulesForBot) {
    if (!rule.value) {
      continue;
    }

    const regexText =
      "^" +
      rule.value
        .replace(
          /[.+^${}()|[\]\\]/g,
          "\\$&"
        )
        .replace(
          /\*/g,
          ".*"
        );

    const regex =
      new RegExp(regexText);

    if (
      regex.test(path) &&
      (
        !best ||
        rule.value.length >
          best.value.length
      )
    ) {
      best = rule;
    }
  }

  return (
    !best ||
    best.type === "allow"
  );
}


// ============================================================
// HOST DELAY
// ============================================================

async function getHostWait(
  env,
  host
) {
  const row =
    await env.DB
      .prepare(`
        SELECT next_allowed_at
        FROM host_state
        WHERE host = ?
        LIMIT 1
      `)
      .bind(
        host.toLowerCase()
      )
      .first();

  return Math.max(
    0,
    Number(
      row?.next_allowed_at || 0
    ) - Date.now()
  );
}


async function setHostNext(
  env,
  host,
  timestamp
) {
  await env.DB
    .prepare(`
      INSERT INTO host_state (
        host,
        next_allowed_at
      )
      VALUES (?, ?)
      ON CONFLICT(host)
      DO UPDATE SET
        next_allowed_at =
          excluded.next_allowed_at
    `)
    .bind(
      host.toLowerCase(),
      timestamp
    )
    .run();
}


// ============================================================
// URL NORMALIZER
// ============================================================

function normalizeUrl(raw) {
  if (!raw) {
    return null;
  }

  try {
    const url =
      new URL(
        String(raw).trim()
      );

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    if (
      url.username ||
      url.password
    ) {
      return null;
    }

    const host =
      url.hostname.toLowerCase();

    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      isPrivateIPv4(host)
    ) {
      return null;
    }

    url.hostname = host;
    url.hash = "";

    for (
      const [key] of [
        ...url.searchParams
      ]
    ) {
      if (
        /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i
          .test(key)
      ) {
        url.searchParams.delete(
          key
        );
      }
    }

    if (
      (
        url.protocol === "http:" &&
        url.port === "80"
      ) ||
      (
        url.protocol === "https:" &&
        url.port === "443"
      )
    ) {
      url.port = "";
    }

    if (
      url.pathname.length > 1
    ) {
      url.pathname =
        url.pathname.replace(
          /\/+$/,
          ""
        );
    }

    return url.href;
  } catch {
    return null;
  }
}


function isPrivateIPv4(host) {
  if (
    !/^\d+(\.\d+){3}$/.test(host)
  ) {
    return false;
  }

  const parts =
    host.split(".").map(Number);

  if (
    parts.some(
      n =>
        n < 0 ||
        n > 255
    )
  ) {
    return true;
  }

  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (
      parts[0] === 172 &&
      parts[1] >= 16 &&
      parts[1] <= 31
    ) ||
    (
      parts[0] === 192 &&
      parts[1] === 168
    ) ||
    (
      parts[0] === 169 &&
      parts[1] === 254
    )
  );
}


// ============================================================
// HTML ENTITIES
// ============================================================

function decodeEntities(text) {
  return text
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&#(\d+);/g,
      (_, n) => {
        const value =
          Number(n);

        return Number.isFinite(
          value
        )
          ? String.fromCodePoint(
              Math.min(
                value,
                0x10ffff
              )
            )
          : _;
      }
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) => {
        const value =
          parseInt(
            n,
            16
          );

        return Number.isFinite(
          value
        )
          ? String.fromCodePoint(
              Math.min(
                value,
                0x10ffff
              )
            )
          : _;
      }
    );
}


// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8"
      }
    }
  );
}


function withCors(response) {
  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  headers.set(
    "Cache-Control",
    "no-store"
  );

  return new Response(
    response.body,
    {
      status:
        response.status,
      headers
    }
  );
}
