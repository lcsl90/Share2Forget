"use strict";

const $ = (id) => document.getElementById(id);
const viewHome = $("view-home");
const viewChannel = $("view-channel");

const CODE_RE = /^[A-Za-z0-9]{5}$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

const state = {
  code: null,
  token: null,
  connection: null,
};

// ---------- kleine Helfer ----------

function myName() {
  return $("username").value.trim() || "Anonym";
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

// ---------- Nachrichten rendern ----------

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

function renderMessage(msg) {
  const list = $("messages");
  const mine = state.connection && msg.senderId === state.connection.connectionId;

  const item = document.createElement("div");
  item.className = "msg" + (mine ? " mine" : "");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${msg.sender} · ${formatTime(msg.sentAt)}`;
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
    file.textContent = "📄 " + msg.fileName;
    body.appendChild(file);
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(msg.fileSize);
    body.appendChild(size);
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
  $("message-input").focus();
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
  const code = $("create-code").value.trim();
  const password = $("create-password").value;
  if (code && !CODE_RE.test(code)) {
    toast("Der Code muss aus genau 5 Buchstaben oder Zahlen bestehen.", "error");
    return;
  }
  const res = await api("/api/channels", { method: "POST", body: { code: code || null, password: password || null } });
  if (!res.ok) {
    toast(res.data.error || "Erstellen fehlgeschlagen.", "error");
    return;
  }
  $("create-code").value = "";
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
  lock.textContent = ch.hasPassword ? "🔒" : "";
  lock.title = ch.hasPassword ? "Passwortgeschützt" : "";
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
  del.className = "btn danger small";
  del.textContent = "🗑";
  del.title = "Channel löschen";
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
  progress.textContent = `⬆ ${file.name} … 0 %`;
  list.appendChild(progress);
  list.scrollTop = list.scrollHeight;

  const xhr = new XMLHttpRequest();
  xhr.open("PUT", url);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      progress.textContent = `⬆ ${file.name} … ${Math.round((e.loaded / e.total) * 100)} %`;
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

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const text = input.value.trim();
  if (!text || !state.code || !state.connection) return;
  input.value = "";
  try {
    const res = await state.connection.invoke("SendMessage", state.code, text);
    if (res && !res.ok) toast(res.error, "error");
  } catch {
    toast("Senden fehlgeschlagen.", "error");
  }
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
  const code = state.code || "";
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(code);
    } else {
      // http://<LAN-IP> ist kein Secure Context – Fallback über execCommand
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Code kopiert.", "success");
  } catch {
    toast("Kopieren fehlgeschlagen.", "error");
  }
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
