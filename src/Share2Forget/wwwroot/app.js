"use strict";

const $ = (id) => document.getElementById(id);
const viewHome = $("view-home");
const viewChannel = $("view-channel");

const CODE_RE = /^[A-Za-z0-9]{5}$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const MAX_TEXT_LEN = 20000;
const MAX_HTML_LEN = 100000;

const state = {
  code: null,
  token: null,
  connection: null,
};

// ---------- kleine Helfer ----------

function myName() {
  return $("username").value.trim() || "Anonym";
}

/** Erzeugt ein <svg><use> auf ein Symbol aus dem Sprite in index.html. */
function icon(name, cls = "icon") {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
  return tpl.content.firstChild;
}

const tokenStore = {
  load() {
    try { return JSON.parse(localStorage.getItem("s2f-tokens") || "{}"); } catch { return {}; }
  },
  save(all) { localStorage.setItem("s2f-tokens", JSON.stringify(all)); },
  get(code) { return this.load()[code] || null; },
  set(code, token) { const all = this.load(); all[code] = token; this.save(all); },
  remove(code) { const all = this.load(); delete all[code]; this.save(all); },
};

let toastTimer = null;
function toast(text, kind = "info") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const hasBody = options.body !== undefined;
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { }
  return { status: res.status, ok: res.ok, data };
}

function formatSize(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + " " + units[i];
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

// ---------- Zwischenablage ----------

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { }
  // http://<LAN-IP> ist kein Secure Context – Fallback über execCommand
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { }
  ta.remove();
  return ok;
}

/** Kopiert formatiertes HTML samt Plaintext-Fallback in die Zwischenablage. */
async function copyRich(html, text) {
  if (navigator.clipboard && window.isSecureContext && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return true;
    } catch { }
  }
  // Fallback: unsichtbares Element selektieren – execCommand kopiert die Formatierung mit
  const host = document.createElement("div");
  host.contentEditable = "true";
  host.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  host.appendChild(sanitizeHtml(html));
  document.body.appendChild(host);
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(host);
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { }
  sel.removeAllRanges();
  host.remove();
  return ok;
}

function flashCheck(btn) {
  btn.replaceChildren(icon("i-check"));
  btn.classList.add("ok");
  setTimeout(() => {
    btn.replaceChildren(icon("i-copy"));
    btn.classList.remove("ok");
  }, 1400);
}

// ---------- HTML-Sanitizing (Whitelist, DOM-basiert) ----------
// Wird auf alles angewendet, was in den DOM gerendert oder verschickt wird –
// der Server sanitized zusätzlich, aber die Clients verlassen sich nicht darauf.

const SANITIZE = {
  allowed: new Set([
    "P", "BR", "HR", "BLOCKQUOTE", "PRE", "UL", "OL", "LI",
    "B", "STRONG", "I", "EM", "U", "S", "DEL", "CODE", "A",
    "H1", "H2", "H3", "H4", "MARK", "SUB", "SUP",
    "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
  ]),
  rename: { STRIKE: "S", DIV: "P", SECTION: "P", ARTICLE: "P", H5: "H4", H6: "H4", TFOOT: "TBODY" },
  drop: new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEXTAREA", "NOSCRIPT",
    "TITLE", "HEAD", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "SELECT", "OPTION",
    "AUDIO", "VIDEO", "SOURCE", "TRACK", "CANVAS", "MAP", "AREA", "FRAME", "FRAMESET",
  ]),
  block: /^(P|DIV|BLOCKQUOTE|PRE|UL|OL|LI|H[1-6]|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER)$/,
  langRe: /^language-[A-Za-z0-9#+.\-]{1,30}$/,
};

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return cleanChildren(doc.body);
}

function cleanChildren(node) {
  const frag = document.createDocumentFragment();
  for (const child of node.childNodes) {
    const cleaned = cleanNode(child);
    if (cleaned) frag.appendChild(cleaned);
  }
  return frag;
}

function cleanNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  let tag = node.tagName;
  if (SANITIZE.drop.has(tag)) return null;
  tag = SANITIZE.rename[tag] || tag;

  // Google Docs packt alles in <b style="font-weight:normal"> – das ist kein Fett.
  if ((tag === "B" || tag === "STRONG") && /^(normal|400)$/.test(node.style?.fontWeight || ""))
    return cleanChildren(node);

  // Container mit Block-Kindern auflösen statt <p> in <p> zu erzeugen
  if (tag === "P" && node.tagName !== "P" && hasBlockChild(node))
    return cleanChildren(node);

  if (!SANITIZE.allowed.has(tag))
    return applyInlineStyles(node, cleanChildren(node));

  const el = document.createElement(tag);
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return cleanChildren(node);
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
  if (tag === "CODE") {
    const lang = (node.getAttribute("class") || "").split(/\s+/).find((c) => SANITIZE.langRe.test(c));
    if (lang) el.className = lang;
  }
  el.appendChild(cleanChildren(node));
  return el;
}

function hasBlockChild(node) {
  for (const child of node.children)
    if (SANITIZE.block.test(child.tagName)) return true;
  return false;
}

/** Überträgt fett/kursiv/unterstrichen aus style-Attributen (Word, Google Docs) auf semantische Tags. */
function applyInlineStyles(node, content) {
  const s = node.style;
  if (!s || !content.hasChildNodes()) return content;
  let out = content;
  const wrap = (tagName) => {
    const w = document.createElement(tagName);
    w.appendChild(out);
    out = w;
  };
  if (s.fontWeight === "bold" || parseInt(s.fontWeight, 10) >= 600) wrap("B");
  if (s.fontStyle === "italic") wrap("I");
  const deco = s.textDecorationLine || s.textDecoration || "";
  if (deco.includes("underline")) wrap("U");
  if (deco.includes("line-through")) wrap("S");
  return out;
}

/** Text-Repräsentation eines DOM-Teilbaums; <br> und Block-Grenzen werden zu Zeilenumbrüchen. */
function textFromNode(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out += child.nodeValue; continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === "BR") { out += "\n"; continue; }
    out += textFromNode(child);
    if (SANITIZE.block.test(child.tagName) && !out.endsWith("\n")) out += "\n";
  }
  return out;
}

// ---------- Code-Erkennung ----------

/** Heuristik: sieht eingefügter Text nach Code/YAML/JSON aus? */
function looksLikeCode(text) {
  const t = text.trim();
  const lines = t.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) {
    // Einzeilig: nur eindeutiges JSON automatisch als Code behandeln
    if (t.length > 8 && ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) {
      try { JSON.parse(t); return true; } catch { return false; }
    }
    return false;
  }
  let score = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^\s{2,}|^\t/.test(raw)) score += 1;                    // Einrückung
    else if (/[;{}[\]()=<>]$/.test(l)) score += 1;              // typische Code-Zeilenenden
    else if (/^[\w."'/$-]+:(\s|$)/.test(l)) score += 1;         // YAML-Key
    else if (/^(#!|#|\/\/|--|import\s|from\s|def\s|class\s|function\s|const\s|let\s|var\s|public\s|private\s|using\s|if\s*\(|for\s*\(|while\s*\(|return\s|<\/?\w+)/.test(l)) score += 1;
    else if (/[={}()<>[\]$|\\]/.test(l)) score += 0.5;
  }
  return score / lines.length >= 0.6;
}

// ---------- Composer (Rich-Text-Eingabe) ----------

const composer = $("message-input");

function inComposer(node) {
  return !!node && composer.contains(node);
}

function closestInComposer(node, selector) {
  let el = node instanceof Element ? node : node?.parentElement;
  if (!el || !composer.contains(el)) return null;
  const found = el.closest(selector);
  return found && found !== composer && composer.contains(found) ? found : null;
}

/** Direktes Kind des Composers, in dem node steckt (Element oder Textknoten). */
function blockOf(node) {
  let cur = node;
  while (cur && cur.parentNode !== composer) cur = cur.parentNode;
  return cur;
}

function isComposerEmpty() {
  if (composer.textContent.trim()) return false;
  return !composer.querySelector("pre, li, blockquote, hr, a");
}

function updateEmpty() {
  composer.classList.toggle("empty", isComposerEmpty());
}

function caretInto(el, atEnd = true) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertNodeAtCaret(node) {
  composer.focus();
  const sel = getSelection();
  let range = sel.rangeCount && inComposer(sel.anchorNode) ? sel.getRangeAt(0) : null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
  }
  range.deleteContents();
  const last = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node;
  range.insertNode(node);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  updateEmpty();
}

function insertPlainText(text, raw) {
  if (!text) return;
  text = text.replace(/\r/g, "");
  if (raw) { insertNodeAtCaret(document.createTextNode(text)); return; }
  const frag = document.createDocumentFragment();
  text.split("\n").forEach((line, i) => {
    if (i) frag.appendChild(document.createElement("br"));
    if (line) frag.appendChild(document.createTextNode(line));
  });
  insertNodeAtCaret(frag);
}

function buildPre(text, lang) {
  const pre = document.createElement("pre");
  if (lang) pre.dataset.language = lang.toLowerCase();
  if (text) pre.textContent = text;
  else pre.appendChild(document.createElement("br"));
  return pre;
}

function unwrapEl(el) {
  const parent = el.parentNode;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

function toggleInlineCode() {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const codeEl = closestInComposer(sel.anchorNode, "code");
  if (codeEl && !codeEl.closest("pre")) { unwrapEl(codeEl); return; }
  if (sel.isCollapsed || !inComposer(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const content = range.extractContents();
  const el = document.createElement("code");
  el.textContent = textFromNode(content).replace(/\n+/g, " ").trim() || content.textContent;
  range.insertNode(el);
  const r = document.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
}

function toggleCodeBlock() {
  const sel = getSelection();
  const pre = sel.rangeCount ? closestInComposer(sel.anchorNode, "pre") : null;
  if (pre) {
    // Code-Block zurück in normale Absätze verwandeln
    const frag = document.createDocumentFragment();
    let lastP = null;
    for (const line of textFromNode(pre).replace(/\n$/, "").split("\n")) {
      const p = document.createElement("p");
      if (line) p.textContent = line;
      else p.appendChild(document.createElement("br"));
      frag.appendChild(p);
      lastP = p;
    }
    pre.replaceWith(frag);
    if (lastP) caretInto(lastP);
    return;
  }
  let text = "";
  if (sel.rangeCount && !sel.isCollapsed && inComposer(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    text = textFromNode(range.cloneContents()).replace(/\n$/, "");
    range.deleteContents();
  }
  const el = buildPre(text, "");
  insertNodeAtCaret(el);
  caretInto(el, !!text);
  for (const p of composer.querySelectorAll("p"))
    if (!p.childNodes.length) p.remove();
}

function makeQuote() {
  const q = document.createElement("blockquote");
  q.appendChild(document.createElement("br"));
  return q;
}

function makeList(tagName) {
  const list = document.createElement(tagName);
  const li = document.createElement("li");
  li.appendChild(document.createElement("br"));
  list.appendChild(li);
  return list;
}

function toggleQuote() {
  const sel = getSelection();
  const bq = sel.rangeCount ? closestInComposer(sel.anchorNode, "blockquote") : null;
  if (bq) { unwrapEl(bq); return; }
  document.execCommand("formatBlock", false, "blockquote");
  // execCommand greift auf leerem Caret nicht zuverlässig – dann direkt einfügen
  if (!closestInComposer(getSelection().anchorNode, "blockquote")) {
    const q = makeQuote();
    insertNodeAtCaret(q);
    caretInto(q, false);
  }
}

function insertLink() {
  const sel = getSelection();
  const saved = sel.rangeCount && inComposer(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  const input = prompt("Link-Adresse:", "https://");
  if (!input || input === "https://") return;
  const url = /^(https?:\/\/|mailto:)/i.test(input) ? input : "https://" + input;
  composer.focus();
  if (saved) {
    sel.removeAllRanges();
    sel.addRange(saved);
  }
  if (saved && !saved.collapsed) {
    document.execCommand("createLink", false, url);
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = input;
    const frag = document.createDocumentFragment();
    frag.append(a, document.createTextNode("\u00a0"));
    insertNodeAtCaret(frag);
  }
}

function clearFormatting() {
  document.execCommand("removeFormat");
  document.execCommand("unlink");
  const anchor = getSelection().anchorNode;
  const codeEl = closestInComposer(anchor, "code");
  if (codeEl && !codeEl.closest("pre")) unwrapEl(codeEl);
  if (closestInComposer(anchor, "pre")) { toggleCodeBlock(); return; }
  if (closestInComposer(anchor, "li")) {
    document.execCommand("outdent");
    document.execCommand("outdent");
  }
  const bq = closestInComposer(anchor, "blockquote");
  if (bq) unwrapEl(bq);
}

const toolbarActions = {
  "inline-code": toggleInlineCode,
  "code-block": toggleCodeBlock,
  quote: toggleQuote,
  link: insertLink,
  clear: clearFormatting,
};

function updateToolbar() {
  const tb = $("toolbar");
  const sel = getSelection();
  const inside = !!(sel && sel.rangeCount && inComposer(sel.anchorNode));
  for (const btn of tb.querySelectorAll("button[data-cmd]")) {
    let on = false;
    if (inside) { try { on = document.queryCommandState(btn.dataset.cmd); } catch { } }
    btn.classList.toggle("active", on);
  }
  const codeEl = inside ? closestInComposer(sel.anchorNode, "code") : null;
  const states = {
    "inline-code": codeEl && !codeEl.closest("pre"),
    "code-block": inside && closestInComposer(sel.anchorNode, "pre"),
    quote: inside && closestInComposer(sel.anchorNode, "blockquote"),
  };
  for (const [action, on] of Object.entries(states))
    tb.querySelector(`[data-action="${action}"]`)?.classList.toggle("active", !!on);
}

/** Markdown-Kurzbefehle beim Tippen: ```lang, > , - , 1. , `code` */
function autoformat() {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (!inComposer(node) || node === composer) return;
  if (closestInComposer(node, "pre") || closestInComposer(node, "code")) return;

  const block = blockOf(node);
  if (!block) return;
  const text = (block.textContent || "").replace(/\u00a0/g, " ");

  const fence = text.match(/^```([A-Za-z0-9#+.\-]*) ?$/);
  if (fence && (fence[1] === "" || text.endsWith(" "))) {
    const pre = buildPre("", fence[1]);
    composer.replaceChild(pre, block);
    caretInto(pre, false);
    return;
  }
  if (text === "> ") { replaceWithBlock(block, makeQuote()); return; }
  if (text === "- " || text === "* ") { replaceWithBlock(block, makeList("ul"), "li"); return; }
  if (text === "1. ") { replaceWithBlock(block, makeList("ol"), "li"); return; }

  if (node.nodeType === Node.TEXT_NODE) {
    const before = node.nodeValue.slice(0, sel.anchorOffset);
    const m = before.match(/`([^`\n]+)`$/);
    if (m) {
      const range = document.createRange();
      range.setStart(node, sel.anchorOffset - m[0].length);
      range.setEnd(node, sel.anchorOffset);
      range.deleteContents();
      const codeEl = document.createElement("code");
      codeEl.textContent = m[1];
      range.insertNode(codeEl);
      const tail = document.createTextNode("\u00a0");
      codeEl.after(tail);
      const r = document.createRange();
      r.setStart(tail, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
}

/** Ersetzt einen Composer-Block durch ein neues Element und setzt den Caret hinein. */
function replaceWithBlock(block, el, caretSelector) {
  composer.replaceChild(el, block);
  caretInto(caretSelector ? el.querySelector(caretSelector) || el : el, false);
}

/** Serialisiert den Composer zu { text, html }; html ist null bei reinem Text. */
function buildMessage() {
  const text = composer.innerText.replace(/\u00a0/g, " ").trim();
  if (!text) return { text: "", html: null };

  const clone = composer.cloneNode(true);
  // Composer-Code-Blöcke in die Draht-Form <pre><code class="language-…"> bringen
  for (const pre of [...clone.querySelectorAll("pre")]) {
    const rebuilt = document.createElement("pre");
    const codeEl = document.createElement("code");
    const lang = (pre.dataset.language || "").toLowerCase();
    if (lang) codeEl.className = "language-" + lang;
    codeEl.textContent = textFromNode(pre).replace(/\n$/, "");
    rebuilt.appendChild(codeEl);
    pre.replaceWith(rebuilt);
  }
  const holder = document.createElement("div");
  holder.appendChild(sanitizeHtml(clone.innerHTML));
  const trivial = !holder.querySelector("*:not(br)");
  return { text, html: trivial ? null : holder.innerHTML };
}

async function sendMessage() {
  if (!state.code || !state.connection) return;
  const { text, html } = buildMessage();
  if (!text) return;
  if (text.length > MAX_TEXT_LEN || (html && html.length > MAX_HTML_LEN)) {
    toast("Nachricht zu lang – bitte kürzen oder als Datei senden.", "error");
    return;
  }
  composer.replaceChildren();
  updateEmpty();
  try {
    const res = await state.connection.invoke("SendMessage", state.code, text, html);
    if (res && !res.ok) toast(res.error, "error");
  } catch {
    toast("Senden fehlgeschlagen.", "error");
    // Inhalt wiederherstellen, damit nichts verloren geht
    if (html) composer.appendChild(sanitizeHtml(html));
    else insertPlainText(text, false);
    updateEmpty();
  }
}

// ---------- Nachrichten rendern ----------

const HLJS_AUTO = [
  "yaml", "json", "xml", "markdown", "javascript", "typescript", "csharp", "python", "java",
  "go", "rust", "cpp", "c", "bash", "shell", "sql", "ini", "css", "php", "ruby", "kotlin",
  "swift", "plaintext",
].filter((l) => window.hljs && hljs.getLanguage(l));

function displayLang(lang) {
  const map = {
    csharp: "C#", cpp: "C++", javascript: "JavaScript", typescript: "TypeScript",
    plaintext: "Text", xml: "XML/HTML", yaml: "YAML", json: "JSON", sql: "SQL",
    css: "CSS", php: "PHP", ini: "INI",
  };
  if (!lang) return "Code";
  return map[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
}

function fileUrl(msg, download) {
  return `/api/channels/${encodeURIComponent(state.code)}/files/${encodeURIComponent(msg.fileId)}`
    + `?t=${encodeURIComponent(state.token)}` + (download ? "&dl=1" : "");
}

function linkify(text, target) {
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0, match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) target.appendChild(document.createTextNode(text.slice(last, match.index)));
    const a = document.createElement("a");
    a.href = match[0];
    a.textContent = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    target.appendChild(a);
    last = match.index + match[0].length;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

/** Macht URLs in Textknoten klickbar – außer in Links und Code. */
function linkifyTree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (!/https?:\/\//.test(n.nodeValue)) continue;
    const el = n.parentElement;
    if (el && !el.closest("a, code, pre")) targets.push(n);
  }
  for (const node of targets) {
    const span = document.createElement("span");
    linkify(node.nodeValue, span);
    node.replaceWith(...span.childNodes);
  }
}

/** Code-Blöcke highlighten und mit Kopf (Sprache + Kopieren) versehen, URLs verlinken. */
function enhanceRichBody(body) {
  linkifyTree(body);
  for (const pre of [...body.querySelectorAll("pre")]) {
    let codeEl = pre.querySelector("code");
    if (!codeEl) {
      codeEl = document.createElement("code");
      codeEl.textContent = textFromNode(pre).replace(/\n$/, "");
      pre.replaceChildren(codeEl);
    }
    const raw = codeEl.textContent;
    let lang = (codeEl.className.match(/language-([A-Za-z0-9#+.\-]+)/) || [])[1]?.toLowerCase();
    if (window.hljs && raw.length <= 30000) {
      try {
        let result;
        if (lang && hljs.getLanguage(lang)) result = hljs.highlight(raw, { language: lang });
        else {
          result = hljs.highlightAuto(raw, HLJS_AUTO);
          lang = result.language;
        }
        codeEl.innerHTML = result.value;
      } catch { }
    }
    codeEl.classList.add("hljs");

    const box = document.createElement("div");
    box.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const langLabel = document.createElement("span");
    langLabel.className = "code-lang";
    langLabel.textContent = displayLang(lang);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-copy";
    btn.title = "Code kopieren";
    btn.appendChild(icon("i-copy"));
    btn.addEventListener("click", async () => {
      (await copyText(raw)) ? flashCheck(btn) : toast("Kopieren fehlgeschlagen.", "error");
    });
    head.append(langLabel, btn);
    pre.replaceWith(box);
    box.append(head, pre);
  }
}

async function copyMessage(msg, btn) {
  let ok;
  if (msg.html) {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeHtml(msg.html));
    ok = await copyRich(holder.innerHTML, msg.text || holder.innerText);
  } else {
    ok = await copyText(msg.text || "");
  }
  ok ? flashCheck(btn) : toast("Kopieren fehlgeschlagen.", "error");
}

function renderMessage(msg) {
  const list = $("messages");
  const mine = state.connection && msg.senderId === state.connection.connectionId;

  const item = document.createElement("div");
  item.className = "msg" + (mine ? " mine" : "");

  const meta = document.createElement("div");
  meta.className = "meta";
  const metaLabel = document.createElement("span");
  metaLabel.textContent = `${msg.sender} · ${formatTime(msg.sentAt)}`;
  meta.appendChild(metaLabel);
  if (msg.type === "text") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-copy";
    btn.title = "Nachricht formatiert kopieren";
    btn.appendChild(icon("i-copy"));
    btn.addEventListener("click", () => copyMessage(msg, btn));
    meta.appendChild(btn);
  }
  item.appendChild(meta);

  const body = document.createElement("div");
  body.className = "body";

  if (msg.type === "file") {
    if (IMAGE_RE.test(msg.fileName || "")) {
      const link = document.createElement("a");
      link.href = fileUrl(msg, false);
      link.target = "_blank";
      link.rel = "noopener";
      const img = document.createElement("img");
      img.src = fileUrl(msg, false);
      img.alt = msg.fileName;
      img.loading = "lazy";
      link.appendChild(img);
      body.appendChild(link);
    }
    const file = document.createElement("a");
    file.className = "file-link";
    file.href = fileUrl(msg, true);
    file.appendChild(icon("i-file"));
    file.appendChild(document.createTextNode(msg.fileName));
    body.appendChild(file);
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(msg.fileSize);
    body.appendChild(size);
  } else if (msg.html) {
    body.classList.add("rich");
    body.appendChild(sanitizeHtml(msg.html));
    enhanceRichBody(body);
  } else {
    linkify(msg.text || "", body);
  }

  item.appendChild(body);
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
  return item;
}

// ---------- Hub-Verbindung ----------

function getConnection() {
  if (state.connection) return state.connection;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl("/hub")
    .withAutomaticReconnect()
    .build();

  connection.on("message", (code, msg) => {
    if (code === state.code) renderMessage(msg);
  });

  connection.on("presence", (code, users) => {
    if (code === state.code) $("channel-users").textContent = `${users} online`;
  });

  connection.on("channelDeleted", (code) => {
    tokenStore.remove(code);
    if (code === state.code) {
      showHome();
      toast(`Channel ${code} wurde gelöscht.`, "warn");
    }
  });

  connection.onreconnected(async () => {
    if (!state.code) return;
    try {
      const res = await connection.invoke("Join", state.code, state.token, myName());
      if (res.ok) {
        $("messages").replaceChildren();
        res.messages.forEach(renderMessage);
        $("channel-users").textContent = `${res.users} online`;
      } else {
        showHome();
        toast(res.error, "error");
      }
    } catch {
      showHome();
      toast("Verbindung verloren.", "error");
    }
  });

  connection.onclose(() => {
    if (state.code) toast("Verbindung zum Server getrennt.", "error");
  });

  state.connection = connection;
  return connection;
}

async function ensureStarted() {
  const connection = getConnection();
  if (connection.state === signalR.HubConnectionState.Disconnected) await connection.start();
  return connection;
}

// ---------- Views ----------

function showHome() {
  state.code = null;
  state.token = null;
  viewChannel.hidden = true;
  viewHome.hidden = false;
  if (location.hash) history.replaceState(null, "", location.pathname);
  refreshList();
}

function showChannel() {
  viewHome.hidden = true;
  viewChannel.hidden = false;
  composer.focus();
}

/** Verbindet den Hub und betritt den Channel. false, wenn das Token nicht (mehr) gilt. */
async function enterChannel(code, token) {
  let connection;
  try {
    connection = await ensureStarted();
  } catch {
    toast("Keine Verbindung zum Server.", "error");
    return false;
  }
  const res = await connection.invoke("Join", code, token, myName());
  if (!res.ok) {
    tokenStore.remove(code);
    return false;
  }
  state.code = code;
  state.token = token;
  tokenStore.set(code, token);
  $("channel-code").textContent = code;
  $("channel-users").textContent = `${res.users} online`;
  $("messages").replaceChildren();
  res.messages.forEach(renderMessage);
  history.replaceState(null, "", "#/" + code);
  showChannel();
  return true;
}

// ---------- Erstellen / Beitreten / Löschen ----------

async function createFlow() {
  const password = $("create-password").value;
  const res = await api("/api/channels", { method: "POST", body: { password: password || null } });
  if (!res.ok) {
    toast(res.data.error || "Erstellen fehlgeschlagen.", "error");
    return;
  }
  $("create-password").value = "";
  if (await enterChannel(res.data.code, res.data.token)) {
    toast(`Channel ${res.data.code} wurde erstellt.`, "success");
  }
}

async function joinFlow(code) {
  code = (code || "").trim();
  if (!CODE_RE.test(code)) {
    toast("Der Code muss aus genau 5 Buchstaben oder Zahlen bestehen.", "error");
    return;
  }

  // Bekanntes Token (z. B. nach Reload) zuerst probieren.
  const saved = tokenStore.get(code);
  if (saved && await enterChannel(code, saved)) return;

  let password = null;
  for (;;) {
    const res = await api(`/api/channels/${encodeURIComponent(code)}/join`, { method: "POST", body: { password } });
    if (res.status === 404) {
      toast(res.data.error || `Hier ist niemand – den Channel "${code}" gibt es nicht.`, "warn");
      return;
    }
    if (res.status === 401) {
      password = prompt(
        (password === null ? `Der Channel "${code}" ist passwortgeschützt.` : "Falsches Passwort.") + "\nPasswort:");
      if (password === null) return;
      continue;
    }
    if (!res.ok) {
      toast(res.data.error || "Beitreten fehlgeschlagen.", "error");
      return;
    }
    if (!await enterChannel(code, res.data.token)) toast("Beitreten fehlgeschlagen.", "error");
    return;
  }
}

async function deleteFlow(code) {
  if (!confirm(`Channel "${code}" wirklich löschen?\nAlle Nachrichten und Dateien gehen verloren.`)) return;
  let body = { token: tokenStore.get(code) };
  for (;;) {
    const res = await api(`/api/channels/${encodeURIComponent(code)}/delete`, { method: "POST", body });
    if (res.status === 401) {
      const pw = prompt(`Zum Löschen von "${code}" wird das Channel-Passwort benötigt.\nPasswort:`);
      if (pw === null) return;
      body = { password: pw };
      continue;
    }
    if (res.status === 404) {
      toast(res.data.error || "Diesen Channel gibt es nicht.", "warn");
      refreshList();
      return;
    }
    if (!res.ok) {
      toast(res.data.error || "Löschen fehlgeschlagen.", "error");
      return;
    }
    tokenStore.remove(code);
    toast(`Channel ${code} wurde gelöscht.`, "success");
    refreshList();
    return;
  }
}

// ---------- Channel-Liste ----------

async function refreshList() {
  if (!viewChannel.hidden) return;
  let res;
  try { res = await api("/api/channels"); } catch { return; }
  if (!res.ok || !Array.isArray(res.data)) return;
  $("no-channels").hidden = res.data.length > 0;
  $("channel-list").replaceChildren(...res.data.map(buildChannelRow));
}

function buildChannelRow(ch) {
  const li = document.createElement("li");
  li.className = "channel-row";

  const code = document.createElement("span");
  code.className = "row-code";
  code.textContent = ch.code;
  li.appendChild(code);

  const lock = document.createElement("span");
  lock.className = "row-lock";
  if (ch.hasPassword) {
    lock.appendChild(icon("i-lock"));
    lock.title = "Passwortgeschützt";
  }
  li.appendChild(lock);

  const info = document.createElement("span");
  info.className = "row-info";
  info.textContent = `${ch.users} online · ${ch.messages} Nachrichten`;
  li.appendChild(info);

  const join = document.createElement("button");
  join.className = "btn small";
  join.textContent = "Beitreten";
  join.addEventListener("click", () => joinFlow(ch.code));
  li.appendChild(join);

  const del = document.createElement("button");
  del.className = "btn danger small icon-btn";
  del.title = "Channel löschen";
  del.appendChild(icon("i-trash"));
  del.addEventListener("click", () => deleteFlow(ch.code));
  li.appendChild(del);

  return li;
}

// ---------- Datei-Upload ----------

function uploadFile(file) {
  if (!state.code) return;
  const url = `/api/channels/${encodeURIComponent(state.code)}/files`
    + `?t=${encodeURIComponent(state.token)}`
    + `&name=${encodeURIComponent(file.name)}`
    + `&from=${encodeURIComponent(myName())}`
    + `&sid=${encodeURIComponent(state.connection?.connectionId || "")}`;

  const list = $("messages");
  const progress = document.createElement("div");
  progress.className = "msg mine upload";
  const label = document.createElement("span");
  label.textContent = `${file.name} … 0 %`;
  progress.append(icon("i-upload"), label);
  list.appendChild(progress);
  list.scrollTop = list.scrollHeight;

  const xhr = new XMLHttpRequest();
  xhr.open("PUT", url);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      label.textContent = `${file.name} … ${Math.round((e.loaded / e.total) * 100)} %`;
    }
  };
  xhr.onload = () => {
    progress.remove(); // die echte Nachricht kommt über den Hub zurück
    if (xhr.status >= 400) {
      let msg = xhr.status === 413 ? "Datei zu groß." : "Upload fehlgeschlagen.";
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { }
      toast(`${file.name}: ${msg}`, "error");
    }
  };
  xhr.onerror = () => {
    progress.remove();
    toast(`${file.name}: Upload fehlgeschlagen.`, "error");
  };
  xhr.send(file);
}

// ---------- Events ----------

$("create-form").addEventListener("submit", (e) => { e.preventDefault(); createFlow(); });
$("join-form").addEventListener("submit", (e) => { e.preventDefault(); joinFlow($("join-code").value); });

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

composer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  if (e.key === "Tab" && closestInComposer(getSelection().anchorNode, "pre")) {
    e.preventDefault();
    insertPlainText("  ", true);
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "e") { e.preventDefault(); toggleInlineCode(); updateToolbar(); }
  else if (k === "k") { e.preventDefault(); insertLink(); }
  else if (k === "x" && e.shiftKey) { e.preventDefault(); document.execCommand("strikeThrough"); updateToolbar(); }
});

composer.addEventListener("input", () => {
  autoformat();
  updateEmpty();
});

composer.addEventListener("paste", (e) => {
  e.preventDefault();
  const dt = e.clipboardData;
  if (!dt) return;
  // Bilder/Dateien aus der Zwischenablage (z. B. Screenshots) direkt hochladen
  if (dt.files && dt.files.length) {
    [...dt.files].forEach(uploadFile);
    return;
  }
  const text = dt.getData("text/plain");
  if (closestInComposer(getSelection().anchorNode, "pre")) {
    insertPlainText(text, true); // im Code-Block immer roh einfügen
    return;
  }
  const fence = text.match(/^\s*```([A-Za-z0-9#+.\-]*)\r?\n([\s\S]*?)\r?\n?```\s*$/);
  if (fence) {
    insertNodeAtCaret(buildPre(fence[2].replace(/\r/g, ""), fence[1]));
    return;
  }
  if (looksLikeCode(text)) {
    insertNodeAtCaret(buildPre(text.replace(/\r/g, "").trim(), ""));
    return;
  }
  const html = dt.getData("text/html");
  if (html) {
    insertNodeAtCaret(sanitizeHtml(html));
    return;
  }
  if (text) insertPlainText(text, false);
});

const toolbar = $("toolbar");
toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // Selektion im Composer behalten
toolbar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd], button[data-action]");
  if (!btn) return;
  composer.focus();
  if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd);
  else toolbarActions[btn.dataset.action]?.();
  updateToolbar();
  updateEmpty();
});

document.addEventListener("selectionchange", () => {
  if (!viewChannel.hidden) updateToolbar();
});

$("file-input").addEventListener("change", (e) => {
  [...e.target.files].forEach(uploadFile);
  e.target.value = "";
});

$("btn-leave").addEventListener("click", async () => {
  const code = state.code;
  if (code && state.connection) {
    try { await state.connection.invoke("Leave", code); } catch { }
  }
  showHome();
});

$("btn-delete").addEventListener("click", () => {
  if (state.code) deleteFlow(state.code);
});

$("btn-copy").addEventListener("click", async () => {
  (await copyText(state.code || ""))
    ? toast("Code kopiert.", "success")
    : toast("Kopieren fehlgeschlagen.", "error");
});

// Drag & Drop auf das Chatfenster
let dragDepth = 0;
viewChannel.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  viewChannel.classList.add("dragging");
});
viewChannel.addEventListener("dragover", (e) => e.preventDefault());
viewChannel.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; viewChannel.classList.remove("dragging"); }
});
viewChannel.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  viewChannel.classList.remove("dragging");
  [...e.dataTransfer.files].forEach(uploadFile);
});

// ---------- Start ----------

const nameInput = $("username");
nameInput.value = localStorage.getItem("s2f-name") || "";
nameInput.addEventListener("change", () => localStorage.setItem("s2f-name", nameInput.value.trim()));

(async function init() {
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { }
  updateEmpty();
  refreshList();
  setInterval(refreshList, 5000);
  window.addEventListener("focus", refreshList);

  // #/CODE in der URL: nach Reload oder über geteilten Link direkt in den Channel
  const match = location.hash.match(/^#\/([A-Za-z0-9]{5})$/);
  if (match) {
    const code = match[1];
    const token = tokenStore.get(code);
    if (token && await enterChannel(code, token).catch(() => false)) return;
    history.replaceState(null, "", location.pathname);
    joinFlow(code);
  }
})();
