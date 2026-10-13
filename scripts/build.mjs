/**
 * Build the static resource list site from the Floccus bookmark export.
 *
 * Reads the synchronized `index.html` (never modified) and writes a
 * pre-rendered page to `dist/index.html`.
 *
 * @module build
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = path.join(ROOT_DIRECTORY, "index.html");
const OUTPUT_DIRECTORY = path.join(ROOT_DIRECTORY, "dist");
const SITE_TITLE = "Miracles Journey 资源列表";

const TITLE_SUFFIX_PATTERNS = [
  /\s+-\s+MC百科\|.*$/u,
  /\s+-\s+Minecraft\s+[\w\s]+(?:\s+-\s+CurseForge)?$/u,
];

const SOURCE_LABELS = new Map([
  ["www.mcmod.cn", "MC百科"],
  ["www.curseforge.com", "CurseForge"],
  ["modrinth.com", "Modrinth"],
]);

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * @typedef {object} BookmarkLink
 * @property {string} url - Target URL.
 * @property {string} key - Bracketed identifier such as `AlexsMobs`, or an empty string.
 * @property {string} name - Human-readable display name.
 * @property {string} source - Short label of the hosting site.
 */

/**
 * @typedef {object} BookmarkFolder
 * @property {string} id - Floccus folder ID.
 * @property {string} title - Folder title.
 * @property {BookmarkLink[]} links - Links directly inside this folder.
 * @property {BookmarkFolder[]} children - Nested folders.
 */

/**
 * Decode the HTML entities used in Netscape bookmark files.
 *
 * @param {string} text - Raw HTML text.
 * @returns {string} Decoded text.
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Escape text for safe use in HTML content and attribute values.
 *
 * @param {string} text - Plain text.
 * @returns {string} Escaped HTML.
 */
function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Split a bookmark title into its bracketed key and display name.
 *
 * @param {string} rawTitle - Decoded bookmark title.
 * @returns {{ key: string, name: string }} Parsed title parts.
 */
function parseTitle(rawTitle) {
  const title = TITLE_SUFFIX_PATTERNS.reduce((current, pattern) => current.replace(pattern, ""), rawTitle.trim());
  const bracketMatch = /^\[([^\]]+)\]\s*(.*)$/u.exec(title);
  if (!bracketMatch) {
    return { key: "", name: title };
  }
  const key = bracketMatch[1].trim();
  return { key, name: bracketMatch[2].trim() || key };
}

/**
 * Create a link record from a bookmark anchor.
 *
 * @param {string} url - Decoded URL.
 * @param {string} rawTitle - Decoded anchor text.
 * @returns {BookmarkLink | null} The link, or `null` when the URL is not HTTP(S).
 */
function createLink(url, rawTitle) {
  let hostname;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }
    hostname = parsedUrl.hostname;
  } catch {
    return null;
  }
  return { url, ...parseTitle(rawTitle), source: SOURCE_LABELS.get(hostname) ?? hostname.replace(/^www\./u, "") };
}

/**
 * Parse a Netscape bookmark file into a folder tree.
 *
 * @param {string} html - Bookmark file contents.
 * @returns {BookmarkFolder} Root folder containing all top-level folders and links.
 */
function parseBookmarks(html) {
  const rootFolder = { id: "root", title: "", links: [], children: [] };
  const folderStack = [];
  let pendingFolder = null;
  const tokenPattern =
    /<H3\b[^>]*?\bID="([^"]*)"[^>]*>([\s\S]*?)<\/H3>|<DL\b[^>]*>|<\/DL>|<A\b[^>]*?\bHREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>/giu;

  for (const match of html.matchAll(tokenPattern)) {
    const [token, folderId, folderTitle, linkUrl, linkTitle] = match;
    const currentFolder = folderStack.at(-1);
    if (folderId !== undefined) {
      pendingFolder = { id: folderId, title: decodeEntities(folderTitle).trim(), links: [], children: [] };
      (currentFolder ?? rootFolder).children.push(pendingFolder);
    } else if (linkUrl !== undefined) {
      const link = createLink(decodeEntities(linkUrl), decodeEntities(linkTitle));
      if (link) {
        (currentFolder ?? rootFolder).links.push(link);
      }
    } else if (token[1] === "/") {
      folderStack.pop();
    } else {
      folderStack.push(pendingFolder ?? (folderStack.length === 0 ? rootFolder : currentFolder));
      pendingFolder = null;
    }
  }
  return rootFolder;
}

/**
 * Count all links in a folder and its descendants.
 *
 * @param {BookmarkFolder} folder - Folder to count.
 * @returns {number} Total number of links.
 */
function countLinks(folder) {
  return folder.children.reduce((total, child) => total + countLinks(child), folder.links.length);
}

/**
 * Render a folder title, splitting `English | 中文` titles into two parts.
 *
 * @param {string} title - Folder title.
 * @returns {string} HTML for the label.
 */
function renderFolderLabel(title) {
  const [englishTitle, localTitle] = title.split(/\s*\|\s*/u);
  if (!localTitle) {
    return `<span class="label">${escapeHtml(title)}</span>`;
  }
  return `<span class="label">${escapeHtml(localTitle)}<small>${escapeHtml(englishTitle)}</small></span>`;
}

/**
 * Render the sidebar navigation tree.
 *
 * @param {BookmarkFolder[]} folders - Folders at the current level.
 * @returns {string} HTML list.
 */
function renderNavigation(folders) {
  const items = folders
    .map((folder) => {
      const nestedList = folder.children.length > 0 ? renderNavigation(folder.children) : "";
      return `<li><a href="#c-${escapeHtml(folder.id)}" data-folder="${escapeHtml(folder.id)}">${renderFolderLabel(folder.title)}<span class="count">${countLinks(folder)}</span></a>${nestedList}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
}

/**
 * Render one bookmark card.
 *
 * @param {BookmarkLink} link - Link to render.
 * @returns {string} HTML list item.
 */
function renderLink(link) {
  const searchText = `${link.key} ${link.name} ${link.source} ${link.url}`.toLowerCase();
  const keyMarkup = link.key && link.key !== link.name ? `<code>${escapeHtml(link.key)}</code>` : "";
  return `<li data-search="${escapeHtml(searchText)}"><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"><span class="name">${escapeHtml(link.name)}</span><span class="meta">${keyMarkup}<span class="source">${escapeHtml(link.source)}</span></span></a></li>`;
}

/**
 * Render a section for every folder that directly contains links.
 *
 * @param {BookmarkFolder} folder - Folder to render.
 * @param {BookmarkFolder[]} ancestors - Ancestor folders, outermost first.
 * @returns {string} HTML sections in document order.
 */
function renderSections(folder, ancestors) {
  const lineage = folder.id === "root" ? [] : [...ancestors, folder];
  let sectionMarkup = "";
  if (folder.links.length > 0) {
    const folderIds = lineage.map((item) => item.id).join(" ");
    const breadcrumb = lineage.map((item) => renderFolderLabel(item.title)).join('<span class="separator">/</span>');
    sectionMarkup = `<section data-folders="${escapeHtml(folderIds)}"><h2>${breadcrumb || "未分类"}<span class="count">${folder.links.length}</span></h2><ul class="cards">${folder.links.map(renderLink).join("")}</ul></section>`;
  }
  return sectionMarkup + folder.children.map((child) => renderSections(child, lineage)).join("");
}

/**
 * Render the complete page.
 *
 * @param {BookmarkFolder} rootFolder - Parsed bookmark tree.
 * @param {string} buildTime - Human-readable build timestamp.
 * @returns {string} Full HTML document.
 */
function renderPage(rootFolder, buildTime) {
  const totalLinks = countLinks(rootFolder);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(SITE_TITLE)}</title>
<script>document.documentElement.dataset.theme=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")</script>
<style>${PAGE_STYLES}</style>
</head>
<body>
<header class="topbar">
  <button class="icon-button menu-button" type="button" aria-label="分类" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
  <h1>${escapeHtml(SITE_TITLE)}</h1>
  <input class="search" type="search" placeholder="搜索名称、ID 或网址  ( / )" aria-label="搜索" autocomplete="off">
  <button class="icon-button theme-button" type="button" aria-label="切换主题"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg></button>
</header>
<div class="layout">
  <nav class="sidebar" aria-label="分类">
    <ul><li><a href="#all" data-folder="all"><span class="label">全部</span><span class="count">${totalLinks}</span></a></li></ul>
    ${renderNavigation(rootFolder.children)}
    <p class="build-info">构建于 ${escapeHtml(buildTime)}</p>
  </nav>
  <main>
    <p class="status" aria-live="polite"></p>
    ${renderSections(rootFolder, [])}
    <p class="empty" hidden>没有匹配的资源</p>
  </main>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

const PAGE_STYLES = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#1d2329;--muted:#6b7480;--border:#e3e6ea;--accent:#2f9e44;--accent-soft:#e6f4e9;--hover:#f0f2f4;--shadow:0 1px 2px rgb(0 0 0/.04)}
[data-theme=dark]{--bg:#121417;--panel:#1a1d21;--text:#e4e7eb;--muted:#8b949e;--border:#2a2f35;--accent:#51cf66;--accent-soft:#1f3326;--hover:#22262b;--shadow:none}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--border)}
.topbar h1{margin:0;font-size:16px;white-space:nowrap}
.search{flex:1;max-width:480px;margin-left:auto;height:36px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.icon-button{display:grid;flex:none;place-items:center;width:36px;height:36px;padding:0;border:1px solid var(--border);border-radius:8px;background:none;color:var(--text);cursor:pointer}
.icon-button svg{width:20px;height:20px}
.icon-button:hover{background:var(--hover)}
.menu-button{display:none}
.layout{display:flex;align-items:flex-start}
.sidebar{position:sticky;top:56px;flex:none;width:248px;height:calc(100vh - 56px);overflow-y:auto;padding:12px 8px;border-right:1px solid var(--border);background:var(--panel)}
.sidebar ul{margin:0;padding:0;list-style:none}
.sidebar ul ul{padding-left:12px}
.sidebar a{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;color:inherit;text-decoration:none}
.sidebar a:hover{background:var(--hover)}
.sidebar a.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.label{flex:1;min-width:0}
.label small{margin-left:6px;color:var(--muted);font-size:12px;font-weight:400}
.count{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.build-info{margin:16px 10px 0;color:var(--muted);font-size:12px}
main{flex:1;min-width:0;padding:16px 24px 48px}
.status{margin:0 0 8px;color:var(--muted);font-size:13px}
section{margin-bottom:28px}
h2{display:flex;align-items:baseline;gap:6px;margin:0 0 10px;font-size:15px}
h2 .label{flex:none}
h2 .count{margin-left:4px}
.separator{color:var(--muted);font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:8px;margin:0;padding:0;list-style:none}
.cards a{display:flex;flex-direction:column;gap:2px;height:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);box-shadow:var(--shadow);color:inherit;text-decoration:none;transition:border-color .15s}
.cards a:hover{border-color:var(--accent)}
.name{overflow:hidden;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;align-items:center;gap:8px;min-width:0;color:var(--muted);font-size:12px}
.meta code{overflow:hidden;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.source{flex:none;margin-left:auto;padding:0 6px;border-radius:4px;background:var(--hover)}
.empty{padding:48px 0;color:var(--muted);text-align:center}
@media (max-width:760px){
.topbar{gap:8px;padding:0 10px}
.topbar h1{display:none}
.search{margin-left:0;max-width:none}
.menu-button{display:grid}
.sidebar{position:fixed;left:0;z-index:20;box-shadow:4px 0 16px rgb(0 0 0/.15);transform:translateX(-100%);transition:transform .2s}
.sidebar.open{transform:none}
main{padding:12px}
.cards{grid-template-columns:minmax(0,1fr)}
}
`;

const PAGE_SCRIPT = `
(() => {
  const searchInput = document.querySelector(".search");
  const sidebar = document.querySelector(".sidebar");
  const menuButton = document.querySelector(".menu-button");
  const statusText = document.querySelector(".status");
  const emptyText = document.querySelector(".empty");
  const sections = [...document.querySelectorAll("main section")].map((element) => ({
    element,
    folderIds: element.dataset.folders.split(" "),
    items: [...element.querySelectorAll("li")],
  }));
  const navigationLinks = [...sidebar.querySelectorAll("a[data-folder]")];

  function selectedFolderId() {
    const hash = decodeURIComponent(location.hash.slice(1));
    return hash.startsWith("c-") ? hash.slice(2) : "all";
  }

  function applyFilters() {
    const folderId = selectedFolderId();
    const terms = searchInput.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    let visibleCount = 0;
    for (const section of sections) {
      const isInFolder = folderId === "all" || section.folderIds.includes(folderId);
      let sectionVisibleCount = 0;
      for (const item of section.items) {
        const isMatch = isInFolder && terms.every((term) => item.dataset.search.includes(term));
        item.hidden = !isMatch;
        if (isMatch) sectionVisibleCount++;
      }
      section.element.hidden = sectionVisibleCount === 0;
      visibleCount += sectionVisibleCount;
    }
    for (const link of navigationLinks) link.classList.toggle("active", link.dataset.folder === folderId);
    statusText.textContent = terms.length > 0 ? "找到 " + visibleCount + " 项" : "共 " + visibleCount + " 项";
    emptyText.hidden = visibleCount > 0;
  }

  function setSidebarOpen(isOpen) {
    sidebar.classList.toggle("open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
  }

  searchInput.addEventListener("input", applyFilters);
  window.addEventListener("hashchange", () => {
    applyFilters();
    setSidebarOpen(false);
    window.scrollTo(0, 0);
  });
  menuButton.addEventListener("click", () => setSidebarOpen(!sidebar.classList.contains("open")));
  document.querySelector(".theme-button").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === "Escape") {
      if (searchInput.value) {
        searchInput.value = "";
        applyFilters();
      }
      setSidebarOpen(false);
    }
  });
  applyFilters();
})();
`;

/**
 * Format the current time in China Standard Time.
 *
 * @returns {string} Timestamp such as `2026-10-13 14:05`.
 */
function formatBuildTime() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

/**
 * Parse the bookmark file and write the generated site.
 *
 * @returns {Promise<void>} Resolves when the site has been written.
 */
async function main() {
  const rootFolder = parseBookmarks(await readFile(SOURCE_FILE, "utf8"));
  const totalLinks = countLinks(rootFolder);
  if (totalLinks === 0) {
    throw new Error(`No bookmarks parsed from ${SOURCE_FILE}`);
  }
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(path.join(OUTPUT_DIRECTORY, "index.html"), renderPage(rootFolder, formatBuildTime()));
  console.log(`Generated ${totalLinks} links in ${rootFolder.children.length} top-level folders.`);
}

await main();
