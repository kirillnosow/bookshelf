const API_URL = window.API_URL || "http://localhost:5000";
console.log("API_URL =", API_URL);

const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

["auth-login", "auth-pass"].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        document.getElementById("auth-submit")?.click();
      }
    });
  }
});

// --- Auth helpers (Basic Auth) ---
const AUTH_KEY = "bookshelf_basic_auth"; // sessionStorage key

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function getAuthHeader() {
  const raw = sessionStorage.getItem(AUTH_KEY);
  return raw ? { Authorization: `Basic ${raw}` } : null;
}

function showAuthModal(show, withError = false) {
  const modal = document.getElementById("auth-modal");
  const err = document.getElementById("auth-error");
  if (!modal) return;

  modal.style.display = show ? "block" : "none";
  if (err) err.style.display = withError ? "block" : "none";

  if (show) {
    setTimeout(() => {
      document.getElementById("auth-login")?.focus();
    }, 50);
  }
}

async function verifyAuth(login, pass) {
  const token = b64encode(`${login}:${pass}`);
  const res = await fetch(`${API_URL}/api/auth/check`, {
    method: "GET",
    headers: { Authorization: `Basic ${token}` },
  });
  return res.ok; // только 200 = успех
}

function ensureAuthGate() {
  if (!sessionStorage.getItem(AUTH_KEY)) {
    showAuthModal(true, false);
  }

  const btn = document.getElementById("auth-submit");
  const form = document.getElementById("auth-form");

  // ✅ Enter в форме
  if (form && !form.dataset.bound) {
    form.dataset.bound = "1";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      btn?.click();
    });
  }

  // ✅ Кнопка "Войти"
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const login = document.getElementById("auth-login")?.value?.trim() || "";
      const pass = document.getElementById("auth-pass")?.value || "";

      if (!login || !pass) {
        showAuthModal(true, true);
        return;
      }

      try {
        const ok = await verifyAuth(login, pass);
        if (!ok) {
          showAuthModal(true, true);
          return;
        }

        sessionStorage.setItem(AUTH_KEY, b64encode(`${login}:${pass}`));
        showAuthModal(false, false);
        window.location.reload();
      } catch {
        showAuthModal(true, true);
      }
    });
  }
}

async function authedFetch(url, options = {}) {
  const hdr = getAuthHeader();
  if (!hdr) {
    showAuthModal(true, false);
    throw new Error("Not authenticated");
  }

  const headers = { ...(options.headers || {}), ...hdr };
  const res = await fetch(url, { ...options, headers }); // <-- ВАЖНО: fetch

  if (res.status === 401) {
    sessionStorage.removeItem(AUTH_KEY);
    showAuthModal(true, true);
    throw new Error("Unauthorized");
  }

  return res;
}

// Call once on load (before any API requests)
ensureAuthGate();

(() => {
  const state = {
    books: [],
    progress: [],
    view: { page: "books", chartMode: "months", chartYear: null, filterYear: "all", chartMetric: "books" }, // page: books|recs
    ui: { loading: true, error: null },
    modals: { addBook: false, editBook: null, addProgress: null },
  };

  // ---------- utils ----------
  const qs = (sel) => document.querySelector(sel);

  function esc(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseDate(s) {
    if (!s) return null;
    const t = String(s).trim();
    if (!t) return null;

    const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
    if (m) {
      const day = Number(m[1]);
      const mon = Number(m[2]) - 1;
      const year = Number(m[3]);
      const hh = m[4] != null ? Number(m[4]) : 0;
      const mm = m[5] != null ? Number(m[5]) : 0;
      const d = new Date(year, mon, day, hh, mm, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    }

    const iso = t.includes("T") ? t : t.replace(" ", "T");
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function initGenreMultiWidgets() {
    document.querySelectorAll('[data-genre-multi="1"]').forEach(root => {
      const id = root.getAttribute("data-genre-id");
      const hidden = qs("#" + id);
      const btn = qs("#" + id + "__btn");
      const chips = qs("#" + id + "__chips");
      const dd = qs("#" + id + "__dd");
      const search = qs("#" + id + "__search");
      const list = qs("#" + id + "__list");
      const clearBtn = qs("#" + id + "__clear");
      const closeBtn = qs("#" + id + "__close");
  
      if (!hidden || !btn || !chips || !dd || !search || !list || !clearBtn || !closeBtn) return;
  
      // защита от повторной инициализации при render()
      if (root.__genreInit) return;
      root.__genreInit = true;
  
      const options = (() => {
        try {
          return JSON.parse(root.getAttribute("data-genre-options") || "[]");
        } catch {
          return GENRE_OPTIONS.slice();
        }
      })();
  
      const normalize = (s) => (s || "").toString().trim().toLowerCase();
  
      const getSelectedSet = () => {
        const arr = parseGenres(hidden.value);
        return new Set(arr.map(normalize));
      };
  
      const setHiddenFromSet = (set) => {
        const selected = [];
        for (const o of options) {
          if (set.has(normalize(o))) selected.push(o);
        }
        hidden.value = joinGenres(selected);
      };
  
      const renderChips = () => {
        const set = getSelectedSet();
        const selected = options.filter(o => set.has(normalize(o)));
  
        if (!selected.length) {
          chips.innerHTML = `<span class="text-sm text-zinc-500">Выбери жанры…</span>`;
          return;
        }
  
        chips.innerHTML = selected.map(o => `
          <span class="inline-flex items-center gap-2 px-2 py-1 rounded-lg text-xs
                       bg-zinc-800 border border-zinc-700 text-zinc-200">
            <span>${esc(o)}</span>
            <button type="button" data-remove="${esc(o)}"
              class="text-zinc-400 hover:text-zinc-100">✕</button>
          </span>
        `).join("");
  
        chips.querySelectorAll("[data-remove]").forEach(x => {
          x.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const val = x.getAttribute("data-remove");
            const set2 = getSelectedSet();
            set2.delete(normalize(val));
            setHiddenFromSet(set2);
            renderAll();
          };
        });
      };
  
      const renderList = () => {
        const q = normalize(search.value);
        const set = getSelectedSet();
  
        const filtered = options.filter(o => normalize(o).includes(q));
  
        if (!filtered.length) {
          list.innerHTML = `<div class="px-3 py-3 text-sm text-zinc-500">Ничего не найдено</div>`;
          return;
        }
  
        list.innerHTML = filtered.map(o => {
          const checked = set.has(normalize(o));
          return `
            <label class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-900 cursor-pointer select-none">
              <input type="checkbox" data-opt="${esc(o)}" ${checked ? "checked" : ""}
                class="h-4 w-4 rounded border-zinc-700 bg-zinc-950"/>
              <span class="text-sm text-zinc-200">${esc(o)}</span>
            </label>
          `;
        }).join("");
  
        list.querySelectorAll('input[type="checkbox"][data-opt]').forEach(cb => {
          cb.onchange = () => {
            const val = cb.getAttribute("data-opt");
            const set2 = getSelectedSet();
            if (cb.checked) set2.add(normalize(val));
            else set2.delete(normalize(val));
            setHiddenFromSet(set2);
            renderChips(); // чипсы обновим сразу
          };
        });
      };
  
      const open = () => {
        dd.classList.remove("hidden");
        search.value = "";
        renderList();
        // чуть позже — чтобы фокус гарантированно встал
        setTimeout(() => search.focus(), 0);
      };
  
      const close = () => {
        dd.classList.add("hidden");
      };
  
      const renderAll = () => {
        renderChips();
        if (!dd.classList.contains("hidden")) renderList();
      };
  
      // кнопка-выбор
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dd.classList.contains("hidden")) open();
        else close();
      };
  
      // поиск
      search.oninput = () => renderList();
  
      // очистка
      clearBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        hidden.value = "";
        renderAll();
        search.focus();
      };
  
      // готово
      closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      };
  
      // закрытие по клику вне
      document.addEventListener("click", (e) => {
        if (!root.contains(e.target)) close();
      });
  
      // закрытие по Esc
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
  
      // первичный рендер
      renderChips();
    });
  }

  function initBookSearchWidgets() {
    document.querySelectorAll('[data-book-search="1"]').forEach(root => {
      const id = root.getAttribute("data-book-id");
      const hidden = qs("#" + id);
      const input = qs("#" + id + "__text");
      const dd = qs("#" + id + "__dd");
      const list = qs("#" + id + "__list");
  
      if (!hidden || !input || !dd || !list) return;
  
      // защита от повторной инициализации при render()
      if (root.__bookInit) return;
      root.__bookInit = true;
  
      const books = (state.books || []).slice().sort((a,b) =>
        (a.title||"").localeCompare(b.title||"", "ru")
      );
  
      const norm = (s) => (s || "").toString().trim().toLowerCase();
  
      const renderList = () => {
        const q = norm(input.value);
  
        const filtered = books.filter(b => {
          const t = norm(b.title);
          const a = norm(b.author);
          return !q || t.includes(q) || a.includes(q);
        });
  
        if (!filtered.length) {
          list.innerHTML = `<div class="px-3 py-3 text-sm text-zinc-500">Ничего не найдено</div>`;
          return;
        }
  
        list.innerHTML = filtered.map(b => {
          const t = (b.title || "").trim();
          const a = (b.author || "").trim();
          return `
            <button type="button"
              class="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-900"
              data-title="${esc(t)}">
              <div class="text-sm text-zinc-100">${esc(t || "Без названия")}</div>
              ${a ? `<div class="text-xs text-zinc-500">${esc(a)}</div>` : ``}
            </button>
          `;
        }).join("");
  
        list.querySelectorAll("button[data-title]").forEach(btn => {
          btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const title = btn.getAttribute("data-title") || "";
            hidden.value = title;     // вот что уйдёт в onSubmitAddProgress()
            input.value = title;      // что видит пользователь
            close();
          };
        });
      };
  
      const open = () => {
        dd.classList.remove("hidden");
        renderList();
      };
  
      const close = () => {
        dd.classList.add("hidden");
      };
  
      input.addEventListener("focus", () => open());
      input.addEventListener("input", () => {
        // допускаем свободный ввод: пусть hidden повторяет текст
        hidden.value = input.value.trim();
        open();
        renderList();
      });
  
      // клик вне — закрыть
      document.addEventListener("click", (e) => {
        if (!root.contains(e.target)) close();
      });
  
      // Esc — закрыть
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
  
      // первичная отрисовка, если фокус сразу попал
      renderList();
    });
  }

  function initAuthorSearchWidgets() {
    document.querySelectorAll('[data-author-search="1"]').forEach(root => {
      const id = root.getAttribute("data-author-id");
      const hidden = qs("#" + id);
      const input = qs("#" + id + "__text");
      const dd = qs("#" + id + "__dd");
      const list = qs("#" + id + "__list");
  
      if (!hidden || !input || !dd || !list) return;
  
      // защита от повторной инициализации при render()
      if (root.__authorInit) return;
      root.__authorInit = true;
  
      const authors = Array.from(
        new Set(
          (state.books || [])
            .map(b => (b.author || "").trim())
            .filter(Boolean)
        )
      ).sort((a,b) => a.localeCompare(b, "ru"));
  
      const norm = (s) => (s || "").toString().trim().toLowerCase();
  
      const renderList = () => {
        const q = norm(input.value);
  
        const filtered = authors.filter(a => !q || norm(a).includes(q));
  
        if (!filtered.length) {
          list.innerHTML = `<div class="px-3 py-3 text-sm text-zinc-500">Ничего не найдено</div>`;
          return;
        }
  
        list.innerHTML = filtered.map(a => `
          <button type="button"
            class="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-900"
            data-author="${esc(a)}">
            <div class="text-sm text-zinc-100">${esc(a)}</div>
          </button>
        `).join("");
  
        list.querySelectorAll("button[data-author]").forEach(btn => {
          btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const a = btn.getAttribute("data-author") || "";
            hidden.value = a;   // что уйдёт в collectBookFromAdd()
            input.value = a;    // что видит пользователь
            close();
          };
        });
      };
  
      const open = () => {
        dd.classList.remove("hidden");
        renderList();
      };
  
      const close = () => {
        dd.classList.add("hidden");
      };
  
      input.addEventListener("focus", () => open());
      input.addEventListener("input", () => {
        hidden.value = input.value.trim(); // свободный ввод разрешаем
        open();
        renderList();
      });
  
      document.addEventListener("click", (e) => {
        if (!root.contains(e.target)) close();
      });
  
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
  
      renderList();
    });
  }  

  function fmtDate(d) {
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function bookYear(b) {
    const status = normalizeStatus(b.status);
  
    // ✅ Все НЕ "прочитано" считаем текущим годом
    if (status !== "completed") {
      return new Date().getFullYear();
    }
  
    // Для "прочитано" — как раньше: finished → year → null
    const d = parseDate(b.finished);
    if (d) return d.getFullYear();
  
    if (typeof b.year === "number") {
      return b.year > 0 ? b.year : null;
    }
  
    const raw = (b.year ?? "").toString().trim();
    if (!raw) return null;          // ✅ пустое не превращаем в 0
  
    const y = Number(raw);
    return Number.isFinite(y) && y > 0 ? y : null;
  }  

  function finishDateForBook(b) {
    const d1 = parseDate(b.finished);
    if (d1) return d1;

    const title = (b.title || "").trim();
    if (title) {
      let best = null;
      for (const p of state.progress) {
        if ((p.book || "").trim() !== title) continue;
        const d = parseDate(p.endAt);
        if (d && (!best || d.getTime() > best.getTime())) best = d;
      }
      if (best) return best;
    }

    const y = bookYear(b);
    if (y) return new Date(y, 11, 31);
    return null;
  }

  function normalizeStatus(s) {
    const v = (s || "").toString().trim().toLowerCase();
    if (v === "прочитано") return "completed";
    if (v === "читаю") return "reading";
    if (v === "хочу прочитать") return "planned";
    if (v === "completed" || v === "complited") return "completed";
    if (v === "reading") return "reading";
    if (v === "planned") return "planned";
    if (v === "запланировано") return "planned";
    return "planned";
  }
  
  function statusToSheet(status) {
    const s = normalizeStatus(status);
    if (s === "completed") return "прочитано";
    if (s === "reading") return "читаю";
    return "хочу прочитать";
  }  

  function statusLabel(status) {
    switch (normalizeStatus(status)) {
      case "planned": return "Хочу прочитать";
      case "reading": return "Читаю";
      case "completed": return "Прочитано";
      default: return "Хочу прочитать";
    }
  }
  
  function normalizeBooks(books) {
    return (books || []).map(b => ({
      ...b,
      status: normalizeStatus(b.status),
    }));
  }  

  function statusPillClass(status) {
    const s = normalizeStatus(status);
    if (s === "completed") return "bg-emerald-900/50 text-emerald-200 border-emerald-800";
    if (s === "reading") return "bg-sky-900/50 text-sky-200 border-sky-800";
    return "bg-zinc-800/70 text-zinc-200 border-zinc-700";
  }

  function hashHue(str) {
    const s = (str || "Other").toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function genreStyle(genre) {
    const hue = hashHue(genre);
    return {
      bg: `hsla(${hue}, 70%, 25%, 0.35)`,
      border: `hsla(${hue}, 70%, 45%, 0.35)`,
      text: `hsla(${hue}, 85%, 75%, 0.95)`,
    };
  }

  function avg(nums) {
    const v = nums.filter(n => typeof n === "number" && !Number.isNaN(n));
    if (!v.length) return null;
    return v.reduce((a,b)=>a+b,0)/v.length;
  }

  // ---------- genres (multi select) ----------
  const GENRE_OPTIONS = [
    "нон-фикшн",
    "художественное",
    "бизнес и управление",
    "автобиография",
    "научпоп",
    "история",
    "понимание себя",
    "эссе",
    "рассказ",
    "сборник",
    "фанфик",
    "любовное",
    "сатира",
    "современное",
    "саморазвитие",
    "политика",
    "экономика",
    "философия",
    "для работы",
    "феминизм",
    "капитализм",
    "любовный роман",
    "классика",
    "детектив",
  ];

  function parseGenres(value) {
    return (value || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);
  }

  function joinGenres(arr) {
    return (arr || [])
      .map(x => (x || "").trim())
      .filter(Boolean)
      .join(", ");
  }

  function bookProgressPercent(b) {
    const pages = Number(b.pages || 0);
    const current = Number(b.currentPage || 0);
    if (!Number.isFinite(pages) || pages <= 0) return null;
    const pct = Math.round((current / pages) * 100);
    return Math.max(0, Math.min(100, pct));
  }
  
  function genresOfBook(b) {
    // b.genre у тебя хранит строку вида "жанр1, жанр2, ..."
    return parseGenres(b.genre || "");
  }  

  function selectGenreMulti(id, label, value = "") {
    // hidden input хранит "жанр1, жанр2, ..."
    const initial = joinGenres(parseGenres(value).map(v => {
      // нормализуем к варианту из списка, если совпало
      const found = GENRE_OPTIONS.find(o => o.toLowerCase() === String(v).toLowerCase());
      return found || v;
    }));
  
    return `
      <div class="genreMulti" data-genre-multi="1" data-genre-id="${esc(id)}" data-genre-options="${esc(JSON.stringify(GENRE_OPTIONS))}">
        <label class="text-sm text-zinc-300">${esc(label)}</label>
  
        <input id="${esc(id)}" type="hidden" value="${esc(initial)}"/>
  
        <div class="relative mt-1">
          <!-- "поле выбора" -->
          <button type="button"
            id="${esc(id)}__btn"
            class="w-full min-h-[44px] px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-left
                   focus:outline-none focus:ring-2 focus:ring-zinc-600 hover:border-zinc-600">
            <div id="${esc(id)}__chips" class="flex flex-wrap gap-2 items-center">
              <span class="text-sm text-zinc-500">Выбери жанры…</span>
            </div>
          </button>
  
          <!-- dropdown -->
          <div id="${esc(id)}__dd"
            class="hidden absolute z-50 mt-2 w-full rounded-xl bg-zinc-950 border border-zinc-800 shadow-xl overflow-hidden">
            <div class="p-2 border-b border-zinc-800">
              <input id="${esc(id)}__search" type="text" placeholder="Поиск жанра…"
                class="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100
                       focus:outline-none focus:ring-2 focus:ring-zinc-600"/>
            </div>
  
            <div id="${esc(id)}__list" class="max-h-64 overflow-y-auto p-2"></div>
  
            <div class="p-2 border-t border-zinc-800 flex items-center justify-between gap-2">
              <button type="button" id="${esc(id)}__clear"
                class="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-sm text-zinc-200">
                Очистить
              </button>
              <button type="button" id="${esc(id)}__close"
                class="px-3 py-2 rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white text-sm font-medium">
                Готово
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function getMultiSelectValues(id) {
    const el = qs("#" + id);
    if (!el) return [];
    return parseGenres(el.value).map(v => {
      const found = GENRE_OPTIONS.find(o => o.toLowerCase() === String(v).toLowerCase());
      return found || v;
    });
  }  

  // ---------- stats ----------
  function computeStats() {
    const now = new Date();
    const yNow = now.getFullYear();
    const yPrev = yNow - 1;

    const completedBooks = state.books.filter(b => normalizeStatus(b.status) === "completed");

    function completedInYear(y) {
      return completedBooks.filter(b => {
        const d = finishDateForBook(b);
        return d && d.getFullYear() === y;
      });
    }

    function avgRatingInYear(y) {
      return avg(
        completedInYear(y)
          .map(b => (typeof b.rating === "number" ? b.rating : null))
      );
    }

    function pagesReadInYear(y) {
      return completedInYear(y).reduce((sum, b) => {
        const p = Number(b.pages || 0);
        return p > 0 ? sum + p : sum;
      }, 0);
    }    

    function avgSpeedInYear(y) {
      let totalPages = 0;
      let totalHours = 0;
      for (const p of state.progress) {
        const start = parseDate(p.startAt);
        const end = parseDate(p.endAt);
        if (!start || !end) continue;
        if (end.getFullYear() !== y) continue;
        const pages = (p.endPage || 0) - (p.startPage || 0);
        if (pages <= 0) continue;
        const hours = (end.getTime() - start.getTime()) / 3600000;
        if (hours <= 0) continue;
        totalPages += pages;
        totalHours += hours;
      }
      return totalHours > 0 ? (totalPages / totalHours) : null;
    }

    const cur = {
      year: yNow,
      completed: completedInYear(yNow).length,
      pagesRead: pagesReadInYear(yNow),
      avgRating: avgRatingInYear(yNow),
      avgSpeed: avgSpeedInYear(yNow),
    };
    
    const prev = {
      year: yPrev,
      completed: completedInYear(yPrev).length,
      pagesRead: pagesReadInYear(yPrev),
      avgRating: avgRatingInYear(yPrev),
      avgSpeed: avgSpeedInYear(yPrev),
    };        

    return { cur, prev };
  }

  function chartData() {
    const completed = state.books.filter(b => normalizeStatus(b.status) === "completed");
    const dates = completed.map(finishDateForBook).filter(Boolean);

    if (!dates.length) {
      const now = new Date();
      const y = now.getFullYear();
      return {
        availableYears: [y],
        years: [y],
        yearCounts: [0],
        monthCounts: Array.from({length:12}, ()=>0),
      };
    }

    const yearsSet = new Set(dates.map(d => d.getFullYear()));
    const availableYears = Array.from(yearsSet).sort((a,b)=>a-b);

    const years = availableYears;
    const yearCounts = years.map(()=>0);

    for (const d of dates) {
      const yi = years.indexOf(d.getFullYear());
      if (yi >= 0) yearCounts[yi] += 1;
    }

    const selectedYear = state.view.chartYear ?? availableYears[availableYears.length - 1];
    const monthCounts = Array.from({length:12}, ()=>0);
    for (const d of dates) {
      if (selectedYear !== "all" && d.getFullYear() !== selectedYear) continue;
      monthCounts[d.getMonth()] += 1;
    }

    return { availableYears, years, yearCounts, monthCounts, selectedYear };
  }

  function monthCountsBooksForYear(y) {
    const counts = Array.from({ length: 12 }, () => 0);
  
    const completed = state.books.filter(b => normalizeStatus(b.status) === "completed");
    for (const b of completed) {
      const d = finishDateForBook(b);
      if (!d) continue;
      if (d.getFullYear() !== y) continue;
      counts[d.getMonth()] += 1;
    }
    return counts;
  }
  
  function monthSumsPagesForYear(y) {
    const sums = Array.from({ length: 12 }, () => 0);
  
    for (const p of (state.progress || [])) {
      const end = parseDate(p.endAt);
      if (!end) continue;
      if (end.getFullYear() !== y) continue;
  
      const pages = (Number(p.endPage || 0) - Number(p.startPage || 0));
      if (!Number.isFinite(pages) || pages <= 0) continue;
  
      sums[end.getMonth()] += pages;
    }
  
    return sums.map(v => Math.round(v));
  }  

  function progressItems() {
    // элементы: { date: Date, pages: number }
    const items = [];
    for (const p of (state.progress || [])) {
      const end = parseDate(p.endAt);
      if (!end) continue;
  
      const pages = (Number(p.endPage || 0) - Number(p.startPage || 0));
      if (!Number.isFinite(pages) || pages <= 0) continue;
  
      items.push({ date: end, pages });
    }
    return items;
  }
  
  function monthTimelineSumData(items) {
    if (!items.length) {
      const now = new Date();
      const y = now.getFullYear();
      return { labels: [`Янв ${y}`], values: [0] };
    }
  
    let min = new Date(items[0].date.getFullYear(), items[0].date.getMonth(), 1);
    let max = new Date(items[0].date.getFullYear(), items[0].date.getMonth(), 1);
  
    for (const it of items) {
      const cur = new Date(it.date.getFullYear(), it.date.getMonth(), 1);
      if (cur < min) min = cur;
      if (cur > max) max = cur;
    }
  
    const monthNames = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
  
    const labels = [];
    const keys = [];
    const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  
    while (cursor <= max) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      labels.push(`${monthNames[m]} ${y}`);
      keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
  
    const sums = new Map(keys.map(k => [k, 0]));
    for (const it of items) {
      const k = `${it.date.getFullYear()}-${String(it.date.getMonth() + 1).padStart(2, "0")}`;
      sums.set(k, (sums.get(k) || 0) + it.pages);
    }
  
    const values = keys.map(k => Math.round(sums.get(k) || 0));
    return { labels, values };
  }
  
  function chartDataPages() {
    const items = progressItems();
    const dates = items.map(x => x.date);
  
    if (!dates.length) {
      const y = new Date().getFullYear();
      return {
        availableYears: [y],
        years: [y],
        yearSums: [0],
        monthSums: Array.from({ length: 12 }, () => 0),
        selectedYear: y,
        timeline: { labels: [`Янв ${y}`], values: [0] },
      };
    }
  
    const yearsSet = new Set(dates.map(d => d.getFullYear()));
    const availableYears = Array.from(yearsSet).sort((a,b)=>a-b);
  
    const years = availableYears;
    const yearSums = years.map(() => 0);
  
    for (const it of items) {
      const yi = years.indexOf(it.date.getFullYear());
      if (yi >= 0) yearSums[yi] += it.pages;
    }
  
    const selectedYear = state.view.chartYear ?? availableYears[availableYears.length - 1];
  
    const monthSums = Array.from({ length: 12 }, () => 0);
    for (const it of items) {
      if (selectedYear !== "all" && it.date.getFullYear() !== selectedYear) continue;
      monthSums[it.date.getMonth()] += it.pages;
    }
  
    const timeline = monthTimelineSumData(items);
  
    return {
      availableYears,
      years,
      yearSums: yearSums.map(x => Math.round(x)),
      monthSums: monthSums.map(x => Math.round(x)),
      selectedYear,
      timeline,
    };
  }  

  function monthTimelineData(dates) {
    if (!dates.length) {
      const now = new Date();
      const y = now.getFullYear();
      return {
        labels: [`Янв ${y}`],
        values: [0],
      };
    }
  
    // min/max по месяцам
    let min = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1);
    let max = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1);
  
    for (const d of dates) {
      const cur = new Date(d.getFullYear(), d.getMonth(), 1);
      if (cur < min) min = cur;
      if (cur > max) max = cur;
    }
  
    const monthNames = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
  
    // генерим все месяцы от min до max включительно
    const labels = [];
    const keys = [];
    const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  
    while (cursor <= max) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth(); // 0..11
      labels.push(`${monthNames[m]} ${y}`);
      keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
  
    const counts = new Map(keys.map(k => [k, 0]));
    for (const d of dates) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  
    const values = keys.map(k => counts.get(k) || 0);
    return { labels, values };
  }  

  // ---------- recommendations ----------
  function computeGenreAffinity() {
    const completed = state.books.filter(
      b => normalizeStatus(b.status) === "completed"
    );

    const map = new Map(); // genre -> { sum, cnt }

    for (const b of completed) {
      if (typeof b.rating !== "number") continue;
      const gs = genresOfBook(b);

      for (const g of gs) {
        const cur = map.get(g) || { sum: 0, cnt: 0 };
        cur.sum += b.rating;
        cur.cnt += 1;
        map.set(g, cur);
      }
    }

    const avg = new Map();
    for (const [g, v] of map.entries()) {
      avg.set(g, v.cnt ? v.sum / v.cnt : 0);
    }
    return avg;
  }

  function recommendPlannedBooks(limit = 9) {
    const planned = state.books.filter(
      b => normalizeStatus(b.status) === "planned"
    );
    if (!planned.length) return [];

    const affinity = computeGenreAffinity();
    const hasAffinity = affinity.size > 0;

    const scored = planned.map(b => {
      const gs = genresOfBook(b);
      let score = 0;
      let reason = "";

      if (hasAffinity) {
        const strong = [];
        for (const g of gs) {
          const a = affinity.get(g);
          if (typeof a === "number") {
            score += a;
            if (a >= 8) strong.push(g);
          }
        }
        if (strong.length) {
          reason = `Похоже, тебе заходят жанры: ${strong.slice(0, 2).join(", ")}`;
        }
      }

      // бонус за автора
      let authorBonus = 0;
      if (hasAffinity && b.author) {
        const best = Math.max(
          ...state.books
            .filter(x =>
              normalizeStatus(x.status) === "completed" &&
              x.author === b.author &&
              typeof x.rating === "number"
            )
            .map(x => x.rating),
          -Infinity
        );
        if (best >= 8) authorBonus = 1.2;
      }

      return { b, score: score + authorBonus, reason };
    });

    scored.sort((a, b) => (b.score - a.score));
    return scored.slice(0, limit);
  }

  function readingNow(limit = 6) {
    const reading = state.books.filter(
      b => normalizeStatus(b.status) === "reading"
    );

    return reading
      .map(b => ({
        b,
        pct: bookProgressPercent(b) ?? -1,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, limit);
  }

  // ---------- api ----------
  async function apiSync() {
    const res = await authedFetch(`${API_URL}/api/sync`);
    if (!res.ok) throw new Error(`sync failed: ${res.status}`);
    return res.json();
  }

  async function apiUpsertBook(book) {
    const res = await authedFetch(`${API_URL}/api/books/upsert`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(book),
    });
    if (!res.ok) throw new Error(`upsert failed: ${res.status}`);
    return res.json();
  }

  async function apiDeleteBook(title, author) {
    const res = await authedFetch(`${API_URL}/api/books/delete`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({title, author}),
    });
    if (!res.ok) throw new Error(`delete failed: ${res.status}`);
    return res.json();
  }

  async function apiAppendProgress(item) {
    const res = await authedFetch(`${API_URL}/api/progress/append`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(item),
    });
    if (!res.ok) throw new Error(`append progress failed: ${res.status}`);
    return res.json();
  }

  // ---------- render ----------
  let chart = null;

  function render(opts = { main: true, modals: true, chart: true }) {
    const root = qs("#app");
    const { loading, error } = state.ui;
    const stats = computeStats();
  
    // 1) гарантируем скелет (создаём только один раз)
    if (!qs("#main") || !qs("#modals")) {
      root.innerHTML = `
        <div id="main"></div>
        <div id="modals"></div>
      `;
    }
  
    // ---------- MAIN HTML (без модалок) ----------
    const availableBookYears = Array.from(
      new Set(state.books.map(bookYear).filter(y => y != null))
    ).sort((a,b)=>a-b);
  
    // ⬇️ УСТАНОВКА ФИЛЬТРА ПО УМОЛЧАНИЮ
    if (state.view.filterYear === "all") {
      const currentYear = new Date().getFullYear();
      if (availableBookYears.includes(currentYear)) {
        state.view.filterYear = currentYear;
      }
    }
  
    const filteredBooks = state.view.filterYear === "all"
      ? state.books
      : state.books.filter(b => String(bookYear(b)) === String(state.view.filterYear));
  
    const mainHtml = `
      <div class="max-w-6xl mx-auto px-4 py-6">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <img src="./icon.png" alt="Bookshelfly" class="h-8 w-8 rounded-lg" />
            <div>
              <div class="text-2xl font-semibold">Bookshelfly</div>

              <div class="mt-2 inline-flex rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                <button id="navBooks"
                  class="px-3 py-1.5 text-sm ${state.view.page==="books"
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-200 hover:bg-zinc-900"}">
                  Книги
                </button>
                <button id="navRecs"
                  class="px-3 py-1.5 text-sm ${state.view.page==="recs"
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-200 hover:bg-zinc-900"}">
                  Рекомендации
                </button>
              </div>
            </div>
          </div>

          <div class="flex gap-2">
            ${state.view.page==="books" ? `
              <button id="btnAddBook" class="px-3 py-2 rounded-xl bg-zinc-100 text-zinc-950 font-medium hover:bg-white">
                Добавить книгу
              </button>
              <button id="btnAddProgress" class="px-3 py-2 rounded-xl bg-zinc-800 text-zinc-100 border border-zinc-700 hover:bg-zinc-700">
                Добавить прогресс
              </button>
            ` : `
              <button id="btnGoBooks" class="px-3 py-2 rounded-xl bg-zinc-800 text-zinc-100 border border-zinc-700 hover:bg-zinc-700">
                На главную
              </button>
            `}
          </div>
        </div>
  
        ${error ? `<div class="mt-4 p-3 rounded-xl bg-red-950/40 border border-red-900 text-red-200">${esc(error)}</div>` : ""}
  
        <div class="mt-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
          ${statCard(
            "Прочитано",
            stats.cur.completed,
            `${stats.prev.year}: ${stats.prev.completed}`,
            stats.cur.completed,
            stats.prev.completed,
            null,
            "",
            "books"
          )}
          
          ${statCard(
            "Прочитано страниц",
            stats.cur.pagesRead,
            `${stats.prev.year}: ${stats.prev.pagesRead}`,
            stats.cur.pagesRead,
            stats.prev.pagesRead,
            null,
            "",
            "pages"
          )}
          
          ${statCard(
            "Средний рейтинг",
            stats.cur.avgRating == null ? "—" : stats.cur.avgRating.toFixed(1),
            `${stats.prev.year}: ${stats.prev.avgRating == null ? "—" : stats.prev.avgRating.toFixed(1)}`,
            stats.cur.avgRating,
            stats.prev.avgRating,
            1,          // decimals
            "",
            "rating"
          )}
          
          ${statCard(
            "Средняя скорость",
            stats.cur.avgSpeed == null ? "—" : `${stats.cur.avgSpeed.toFixed(0)} стр/ч`,
            `${stats.prev.year}: ${stats.prev.avgSpeed == null ? "—" : `${stats.prev.avgSpeed.toFixed(0)} стр/ч`}`,
            stats.cur.avgSpeed,
            stats.prev.avgSpeed,
            0,          // decimals
            " стр/ч",   // suffix for delta
            "speed"
          )}        
        </div>
  
        ${state.view.page === "books" ? `
          <div class="mt-6 p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <select id="chartMetricSelect"
                  class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100">
                  <option value="books" ${state.view.chartMetric==="books"?"selected":""}>Книги</option>
                  <option value="pages" ${state.view.chartMetric==="pages"?"selected":""}>Страницы</option>
                </select>
              </div>
        
              <div class="flex items-center gap-2">
                <button id="btnChartMonths" class="px-3 py-1.5 rounded-lg border ${state.view.chartMode==="months"
                  ? "bg-zinc-100 text-zinc-950 border-zinc-100"
                  : "bg-zinc-900 text-zinc-100 border-zinc-700 hover:bg-zinc-800"}">Месяцы</button>
        
                <button id="btnChartYears" class="px-3 py-1.5 rounded-lg border ${state.view.chartMode==="years"
                  ? "bg-zinc-100 text-zinc-950 border-zinc-100"
                  : "bg-zinc-900 text-zinc-100 border border-zinc-700 hover:bg-zinc-800"}">Годы</button>
        
                ${state.view.chartMode==="months" ? `
                  <select id="chartYearSelect" class="ml-2 px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100">
                    <option value="all" ${state.view.chartYear==="all"?"selected":""}>Все годы</option>
                    ${chartData().availableYears
                      .map(y => `<option value="${y}" ${String(state.view.chartYear ?? chartData().selectedYear)===String(y)?"selected":""}>${y}</option>`)
                      .join("")}
                  </select>
                ` : ``}
              </div>
            </div>
        
            <div class="mt-3">
              <canvas id="chart" height="120"></canvas>
            </div>
          </div>
        
          <div class="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div class="text-lg font-semibold">Мои книги</div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-zinc-400">${loading ? "Загрузка…" : `${filteredBooks.length} книг`}</div>
              <select id="booksYearSelect" class="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100">
                <option value="all" ${state.view.filterYear==="all"?"selected":""}>Все годы</option>
                ${availableBookYears
                  .map(y => `<option value="${y}" ${String(state.view.filterYear)===String(y)?"selected":""}>${y}</option>`)
                  .join("")}
              </select>
            </div>
          </div>
        
          <div class="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${filteredBooks.length ? filteredBooks.map(renderBookCard).join("") : emptyState()}
          </div>
        ` : `
          ${renderRecommendationsPage()}
        `}        
      </div>
    `;
  
    // ---------- MODALS HTML ----------
    const modalsHtml = `
      ${renderAddBookModal()}
      ${renderEditBookModal()}
      ${renderAddProgressModal()}
    `;
  
    // 2) обновляем MAIN только если нужно
    if (opts.main) {
      qs("#main").innerHTML = mainHtml;
      bindMainHandlers();
    }
  
    // 3) модалки обновляем отдельно
    if (opts.modals) {
      qs("#modals").innerHTML = modalsHtml;
      bindModalHandlers();
      initGenreMultiWidgets();
      initBookSearchWidgets();
      initAuthorSearchWidgets();
    }    
  
    // 4) график трогаем только если нужно
    if (opts.chart) {
      renderChart();
    }
  }  

  function diffText(cur, prev, decimals = null) {
    if (cur == null || prev == null) return "";
    if (typeof cur !== "number" || typeof prev !== "number") return "";
    const d = cur - prev;
    if (Number.isNaN(d) || d === 0) return "";
    const sign = d > 0 ? "+" : "−";
    const abs = Math.abs(d);
    const txt = decimals == null ? String(abs) : abs.toFixed(decimals);
    return `(${sign}${txt})`;
  }

  function deltaBadge(cur, prev, decimals = null, suffix = "") {
    if (cur == null || prev == null) return "";
    if (typeof cur !== "number" || typeof prev !== "number") return "";
  
    const d = cur - prev;
    if (!Number.isFinite(d) || d === 0) {
      return `<span class="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs
                    bg-zinc-800/70 border border-zinc-700 text-zinc-300">0</span>`;
    }
  
    const isUp = d > 0;
    const abs = Math.abs(d);
    const val = decimals == null ? String(abs) : abs.toFixed(decimals);
  
    const cls = isUp
      ? "bg-emerald-900/40 border-emerald-700 text-emerald-200"
      : "bg-red-950/40 border-red-800 text-red-200";
  
    const sign = isUp ? "+" : "−";
  
    return `<span class="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs
                  border ${cls}">${sign}${val}${suffix}</span>`;
  }

  function kpiIconSvg(name) {
    // stroke = currentColor → цвет управляется классами Tailwind
    switch (name) {
      case "books": // книга
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        `;
      case "pages": // страницы
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3h9l3 3v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>
            <path d="M15 3v4a2 2 0 0 0 2 2h4"/>
            <path d="M8 13h8"/>
            <path d="M8 17h8"/>
          </svg>
        `;
      case "rating": // звезда
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 18.7 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z"/>
          </svg>
        `;
      case "speed": // молния
        return `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2L3 14h7l-1 8 12-14h-7l-1-6z"/>
          </svg>
        `;
      default:
        return "";
    }
  }  

  function statCard(title, value, subline, curNum = null, prevNum = null, decimals = null, suffix = "", icon = "") {
    return `
      <div class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div class="flex items-center gap-2 text-sm text-zinc-400">
          ${icon ? `
            <span class="inline-flex items-center justify-center h-8 w-8 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300">
              ${kpiIconSvg(icon)}
            </span>
          ` : ``}
          <span>${esc(title)}</span>
        </div>
  
        <div class="mt-1 flex items-baseline gap-2">
          <div class="text-2xl font-semibold">${esc(value)}</div>
          ${deltaBadge(curNum, prevNum, decimals, suffix)}
        </div>
  
        ${subline ? `<div class="mt-1 text-sm text-zinc-500">${esc(subline)}</div>` : ""}
      </div>
    `;
  }  

  function emptyState() {
    return `
      <div class="col-span-full p-10 rounded-2xl bg-zinc-900/30 border border-zinc-800 text-center text-zinc-400">
        На листе «Все книги» пока нет книг.
      </div>
    `;
  }

  function renderBookCard(b) {
    const g = genreStyle(b.genre || "Other");
    const pill = statusPillClass(b.status);
  
    const img = (b.image || "").trim();
    const cover = img
      ? `<img src="${esc(img)}" alt="" class="h-40 w-full object-cover rounded-xl border border-zinc-800" onerror="this.style.display='none'"/>`
      : `<div class="h-40 w-full rounded-xl border border-zinc-800 bg-zinc-900/60 flex items-center justify-center text-zinc-500">Нет обложки</div>`;
  
    const pages = Number(b.pages || 0);
    const current = Number(b.currentPage || 0);
  
    const isCompleted = normalizeStatus(b.status) === "completed";
  
    const progress = isCompleted
      ? 100
      : (pages > 0 ? Math.min(100, Math.round((current / pages) * 100)) : 0);
  
    const pagesLabel = isCompleted && pages > 0
      ? `${pages}/${pages} стр`
      : (pages > 0 ? `${current}/${pages} стр` : `${current} стр`);
  
    return `
      <div class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        ${cover}
  
        <div class="mt-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="font-semibold truncate">${esc(b.title || "")}</div>
            <div class="text-sm text-zinc-400 truncate">${esc(b.author || "")}</div>
          </div>
          <div class="shrink-0 px-2 py-1 rounded-lg border ${pill} text-xs">
            ${esc(statusLabel(b.status))}
          </div>
        </div>
  
        <div class="mt-3 flex flex-wrap gap-2 items-center">
          <div class="px-2 py-1 rounded-lg border text-xs"
            style="background:${g.bg}; border-color:${g.border}; color:${g.text}">
            ${esc(b.genre || "Other")}
          </div>
          ${typeof b.rating === "number" ? `<div class="text-xs text-zinc-300">★ ${b.rating.toFixed(1)}</div>` : ""}
          ${b.year ? `<div class="text-xs text-zinc-500">${esc(b.year)}</div>` : ""}
        </div>
  
        <div class="mt-3">
          <div class="h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div class="h-2 bg-zinc-100" style="width:${progress}%;"></div>
          </div>
          <div class="mt-1 text-xs text-zinc-400">
            ${pagesLabel}
          </div>
        </div>
  
        <div class="mt-4 flex gap-2">
          <button class="btnEdit flex-1 px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 hover:bg-zinc-700"
            data-id="${esc(b.id)}">Редактировать</button>
          <button class="btnDelete px-3 py-2 rounded-xl bg-red-950/40 border border-red-900 hover:bg-red-900/30"
            data-id="${esc(b.id)}">Удалить</button>
        </div>
      </div>
    `;
  }  

  function renderAddBookModal() {
    if (!state.modals.addBook) return "";
    return modalShell("addBookModal", "Добавить книгу", addBookFormHtml(), "Сохранить", "closeAddBook");
  }

  function renderEditBookModal() {
    const b = state.modals.editBook;
    if (!b) return "";
    return modalShell("editBookModal", "Редактировать книгу", editBookFormHtml(b), "Сохранить", "closeEditBook");
  }

  function renderAddProgressModal() {
    const p = state.modals.addProgress;
    if (!p) return "";
    return modalShell("addProgressModal", "Добавить прогресс", addProgressFormHtml(), "Сохранить", "closeAddProgress");
  }

  function modalShell(id, title, bodyHtml, primaryText, closeId) {
    return `
      <div class="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50">
        <div class="w-full max-w-2xl max-h-[85vh] rounded-2xl bg-zinc-950 border border-zinc-800 shadow-xl flex flex-col">
          <div class="p-4 border-b border-zinc-800 flex items-center justify-between">
            <div class="font-semibold">${esc(title)}</div>
            <button id="${closeId}" class="px-2 py-1 rounded-lg hover:bg-zinc-900 text-zinc-300">✕</button>
          </div>
          <div class="p-4 overflow-y-auto flex-1">${bodyHtml}</div>
          <div class="p-4 border-t border-zinc-800 flex justify-end gap-2">
            <button id="${closeId}_2" class="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 hover:bg-zinc-800">Отмена</button>
            <button id="${id}_submit" class="px-3 py-2 rounded-xl bg-zinc-100 text-zinc-950 font-medium hover:bg-white">${esc(primaryText)}</button>
          </div>
        </div>
      </div>
    `;
  }

  function addBookFormHtml() {
    return `
      <div class="grid sm:grid-cols-2 gap-3">
        ${input("ab_title", "Название")}
        ${selectAuthorSearch("ab_author", "Автор")}
        ${selectStatus("ab_status", "Статус")}
        ${selectGenreMulti("ab_genre", "Жанр", "")}
        ${input("ab_pages", "Количество страниц", "number")}
        ${input("ab_image", "Image (url)")}
      </div>
    `;
  }  

  function editBookFormHtml(b) {
    const v = (x) => esc(x ?? "");
    const c = b.criteria || {};
    return `
      <div class="grid sm:grid-cols-2 gap-3">
        ${input("eb_title", "Название", "text", "", v(b.title))}
        ${input("eb_author", "Автор", "text", "", v(b.author))}
        ${selectStatus("eb_status", "Статус", normalizeStatus(b.status))}
        ${selectGenreMulti("eb_genre", "Жанр", b.genre || "")}
        ${input("eb_pages", "Количество страниц", "number", "", v(b.pages||""))}
        ${input("eb_image", "Image (url)", "text", "", v(b.image))}
        ${input("eb_year", "Год", "number", "", v(b.year||""))}
        ${input("eb_finished", "Закончено (YYYY-MM-DD)", "text", "", v(b.finished))}
      </div>

      <div class="mt-4 p-3 rounded-xl bg-zinc-900/50 border border-zinc-800">
        <div class="text-sm font-medium">Оценка по критериям</div>
        <div class="mt-3 grid sm:grid-cols-2 gap-2">
          ${critCheck("eb_usefulness","Полезность", c.usefulness)}
          ${critCheck("eb_engagement","Увлекательность", c.engagement)}
          ${critCheck("eb_clarity","Понятность", c.clarity)}
          ${critCheck("eb_style","Стиль и язык", c.style)}
          ${critCheck("eb_emotions","Эмоции", c.emotions)}
          ${critCheck("eb_relevance","Актуальность", c.relevance)}
          ${critCheck("eb_depth","Глубина", c.depth)}
          ${critCheck("eb_practicality","Практичность", c.practicality)}
          ${critCheck("eb_originality","Оригинальность", c.originality)}
          ${critCheck("eb_recommendation","Рекомендация", b.recommendation)}
        </div>
        <div class="mt-2 text-xs text-zinc-400">Каждая галочка = 1. Итоговый рейтинг считается автоматически как сумма критериев + рекомендация.</div>
      </div>

      <div class="mt-2 text-xs text-zinc-400">ID считается из (Название+Автор). При изменении названия/автора это будет другая книга.</div>
    `;
  }

  function addProgressFormHtml() {
    return `
      <div class="grid sm:grid-cols-2 gap-3">
        <!-- Книга — на всю ширину -->
        <div class="sm:col-span-2">
          ${selectBookSearch("ap_book", "Книга")}
        </div>
  
        <!-- Страницы — в одной строке -->
        ${input("ap_startPage", "Страница старта", "number")}
        ${input("ap_endPage", "Страница завершения", "number")}
  
        <!-- Даты — как было (две колонки) -->
        ${input("ap_startAt", "Дата и время начала чтения", "text", "YYYY-MM-DD HH:mm")}
        ${input("ap_endAt", "Дата и время окончания чтения", "text", "YYYY-MM-DD HH:mm")}
      </div>
    `;
  }  

  function input(id, label, type="text", placeholder="", value="") {
    return `
      <div>
        <label class="text-sm text-zinc-300">${esc(label)}</label>
        <input id="${esc(id)}" type="${esc(type)}" placeholder="${esc(placeholder)}" value="${esc(value)}"
          class="mt-1 w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-600"/>
      </div>
    `;
  }

  function critInput(id, label, value="") {
    return `
      <div>
        <label class="text-xs text-zinc-400">${esc(label)}</label>
        <input id="${esc(id)}" type="number" min="1" max="10" value="${esc(value ?? "")}"
          class="mt-1 w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700"/>
      </div>
    `;
  }

  function critCheck(id, label, checked=false) {
    const isOn = !!checked && checked !== "0" && checked !== 0 && checked !== "false";
    return `
      <label class="flex items-center gap-3 px-3 py-2 rounded-xl bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-900 cursor-pointer select-none">
        <input id="${esc(id)}" type="checkbox" ${isOn ? "checked" : ""} class="h-4 w-4 rounded border-zinc-700 bg-zinc-950"/>
        <span class="text-sm text-zinc-200">${esc(label)}</span>
      </label>
    `;
  }

  function selectStatus(id, label, value="planned") {
    const v = (value || "planned").toLowerCase();
    return `
      <div>
        <label class="text-sm text-zinc-300">${esc(label)}</label>
        <select id="${esc(id)}" class="mt-1 w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700">
          <option value="planned" ${v==="planned"?"selected":""}>Запланировано</option>
          <option value="reading" ${v==="reading"?"selected":""}>Читаю</option>
          <option value="completed" ${v==="completed"?"selected":""}>Прочитано</option>
        </select>
      </div>
    `;
  }

  function inputAuthorWithHints(id, label) {
    const authors = Array.from(
      new Set(
        (state.books || [])
          .map(b => (b.author || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "ru"));
  
    const listId = `${id}__datalist`;
  
    return `
      <div>
        <label class="text-sm text-zinc-300">${esc(label)}</label>
        <input id="${esc(id)}" list="${esc(listId)}" type="text" placeholder="Начни вводить автора…"
          class="mt-1 w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-600"/>
        <datalist id="${esc(listId)}">
          ${authors.map(a => `<option value="${esc(a)}"></option>`).join("")}
        </datalist>
      </div>
    `;
  }  

  function selectBookSearch(id, label) {
    return `
      <div class="bookSearch" data-book-search="1" data-book-id="${esc(id)}">
        <label class="text-sm text-zinc-300">${esc(label)}</label>
  
        <!-- hidden input — сюда попадёт выбранная книга -->
        <input id="${esc(id)}" type="hidden" value=""/>
  
        <div class="relative mt-1">
          <input id="${esc(id)}__text" type="text" autocomplete="off"
            placeholder="Начни вводить название или автора…"
            value=""
            class="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-100
                   focus:outline-none focus:ring-2 focus:ring-zinc-600"/>
  
          <div id="${esc(id)}__dd"
            class="hidden absolute z-50 mt-2 w-full rounded-xl bg-zinc-950 border border-zinc-800 shadow-xl overflow-hidden">
            <div id="${esc(id)}__list" class="max-h-64 overflow-y-auto p-2"></div>
          </div>
        </div>
      </div>
    `;
  }

  function selectAuthorSearch(id, label) {
    return `
      <div class="authorSearch" data-author-search="1" data-author-id="${esc(id)}">
        <label class="text-sm text-zinc-300">${esc(label)}</label>
  
        <!-- hidden input — сюда уйдёт выбранный автор -->
        <input id="${esc(id)}" type="hidden" value=""/>
  
        <div class="relative mt-1">
          <input id="${esc(id)}__text" type="text" autocomplete="off"
            placeholder="Начни вводить автора…"
            value=""
            class="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-100
                   focus:outline-none focus:ring-2 focus:ring-zinc-600"/>
  
          <div id="${esc(id)}__dd"
            class="hidden absolute z-50 mt-2 w-full rounded-xl bg-zinc-950 border border-zinc-800 shadow-xl overflow-hidden">
            <div id="${esc(id)}__list" class="max-h-64 overflow-y-auto p-2"></div>
          </div>
        </div>
      </div>
    `;
  }  

  function closeAnyModal() {
    if (state.modals.addProgress) {
      state.modals.addProgress = null;
      render();
      return;
    }
  
    if (state.modals.editBook) {
      state.modals.editBook = null;
      render();
      return;
    }
  
    if (state.modals.addBook) {
      state.modals.addBook = false;
      render();
      return;
    }
  }  
  
  function bindMainHandlers() {
    const btnAddBook = qs("#btnAddBook");
    const btnAddProgress = qs("#btnAddProgress");

    const navBooks = qs("#navBooks");
    const navRecs = qs("#navRecs");
    const btnGoBooks = qs("#btnGoBooks");

    if (navBooks) navBooks.onclick = () => { state.view.page = "books"; render({ main: true, modals: false, chart: true }); };
    if (navRecs) navRecs.onclick = () => { state.view.page = "recs"; render({ main: true, modals: false, chart: false }); };
    if (btnGoBooks) btnGoBooks.onclick = () => { state.view.page = "books"; render({ main: true, modals: false, chart: true }); };

  
    if (btnAddBook) btnAddBook.onclick = () => {
      state.modals.addBook = true;
      render({ main: false, modals: true, chart: false }); // ✅ только модалка, без графика
    };
  
    if (btnAddProgress) btnAddProgress.onclick = () => {
      state.modals.addProgress = true;
      render({ main: false, modals: true, chart: false }); // ✅ только модалка, без графика
    };
  
    const btnMonths = qs("#btnChartMonths");
    const btnYears = qs("#btnChartYears");
    if (btnMonths) btnMonths.onclick = () => { state.view.chartMode = "months"; render({ main: true, modals: false, chart: true }); };
    if (btnYears) btnYears.onclick = () => { state.view.chartMode = "years"; render({ main: true, modals: false, chart: true }); };
  
    const chartYearSelect = qs("#chartYearSelect");
    if (chartYearSelect) chartYearSelect.onchange = () => {
      const v = chartYearSelect.value;
      state.view.chartYear = v === "all" ? "all" : Number(v);
      render({ main: true, modals: false, chart: true });
    };

    const chartMetricSelect = qs("#chartMetricSelect");
      if (chartMetricSelect) chartMetricSelect.onchange = () => {
        state.view.chartMetric = chartMetricSelect.value; // books | pages
        render({ main: true, modals: false, chart: true });
      };
  
    const booksYearSelect = qs("#booksYearSelect");
    if (booksYearSelect) booksYearSelect.onchange = () => {
      state.view.filterYear = booksYearSelect.value;
      render({ main: true, modals: false, chart: false }); // список/фильтр да, график можно не трогать
    };
  
    document.querySelectorAll(".btnEdit").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const b = state.books.find(x => x.id === id);
        state.modals.editBook = b ? JSON.parse(JSON.stringify(b)) : null;
        render({ main: false, modals: true, chart: false }); // ✅ только модалка
      });
    });
  
    document.querySelectorAll(".btnDelete").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        const b = state.books.find(x => x.id === id);
        if (!b) return;
        if (!confirm(`Удалить книгу “${b.title}”?`)) return;
  
        try {
          const data = await apiDeleteBook(b.title, b.author);
          state.books = normalizeBooks(data.books || []);
          state.progress = data.progress || [];
  
          // данные изменились → перерисуем main + chart
          render({ main: true, modals: true, chart: true });
        } catch (e) {
          state.ui.error = e.message || String(e);
          render({ main: true, modals: true, chart: false });
        }
      });
    });
  }
  
  function bindModalHandlers() {
    wireClose("closeAddBook", () => {
      state.modals.addBook = false;
      render({ main: false, modals: true, chart: false }); // ✅ только модалка
    });
  
    wireClose("closeEditBook", () => {
      state.modals.editBook = null;
      render({ main: false, modals: true, chart: false }); // ✅ только модалка
    });
  
    wireClose("closeAddProgress", () => {
      state.modals.addProgress = null;
      render({ main: false, modals: true, chart: false }); // ✅ только модалка
    });
  
    const addSubmit = qs("#addBookModal_submit");
    if (addSubmit) addSubmit.onclick = onSubmitAddBook;
  
    const editSubmit = qs("#editBookModal_submit");
    if (editSubmit) editSubmit.onclick = onSubmitEditBook;
  
    const progSubmit = qs("#addProgressModal_submit");
    if (progSubmit) progSubmit.onclick = onSubmitAddProgress;
  }  

  function wireClose(id, fn) {
    const a = qs("#"+id);
    const b = qs("#"+id+"_2");
    if (a) a.onclick = fn;
    if (b) b.onclick = fn;
  }

  function getVal(id) {
    const el = qs("#"+id);
    return el ? el.value : "";
  }

  function getNum(id) {
    const s = getVal(id).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function getCheck(id) {
    const el = qs("#"+id);
    return el && el.checked ? 1 : 0;
  }

  async function onSubmitAddBook() {
    const book = collectBookFromAdd();
    try {
      const data = await apiUpsertBook(book);
      state.books = normalizeBooks(data.books || []);
      state.progress = data.progress || [];

      if (state.view.chartYear == null) {
        const cd = chartData();
        state.view.chartYear = cd.selectedYear ?? (cd.availableYears ? cd.availableYears[cd.availableYears.length-1] : new Date().getFullYear());
      }
      state.modals.addBook = false;
      render();
    } catch (e) {
      state.ui.error = e.message || String(e);
      render();
    }
  }

  function collectBookFromAdd() {
    const selectedGenres = getMultiSelectValues("ab_genre");
  
    return {
      title: getVal("ab_title").trim(),
      author: getVal("ab_author").trim(),
      status: statusToSheet(getVal("ab_status")),
      genre: joinGenres(selectedGenres),
      pages: getNum("ab_pages"),
      image: getVal("ab_image").trim(),
  
      // эти поля больше не вводим при добавлении
      year: null,
      finished: "",
      rating: null,
      criteria: {},
      recommendation: 0,
    };
  }  

  async function onSubmitEditBook() {
    const current = state.modals.editBook;
    if (!current) return;

    const criteria = {
      usefulness: getCheck("eb_usefulness"),
      engagement: getCheck("eb_engagement"),
      clarity: getCheck("eb_clarity"),
      style: getCheck("eb_style"),
      emotions: getCheck("eb_emotions"),
      relevance: getCheck("eb_relevance"),
      depth: getCheck("eb_depth"),
      practicality: getCheck("eb_practicality"),
      originality: getCheck("eb_originality"),
    };

    const recommendation = getCheck("eb_recommendation");
    const rating = Object.values(criteria).reduce((a, x) => a + (Number(x) || 0), 0) + recommendation;

    const selectedGenres = getMultiSelectValues("eb_genre");

    const prevStatusNorm = normalizeStatus(current.status);
    const nextStatusNorm = normalizeStatus(getVal("eb_status"));

    const book = {
      title: getVal("eb_title").trim(),
      author: getVal("eb_author").trim(),

      // ✅ статус НЕ отправляем, если он не менялся
      ...(prevStatusNorm !== nextStatusNorm ? { status: statusToSheet(nextStatusNorm) } : {}),

      genre: joinGenres(selectedGenres),
      pages: getNum("eb_pages"),
      image: getVal("eb_image").trim(),
      year: getNum("eb_year"),
      finished: getVal("eb_finished").trim(),
      rating,
      criteria,
      recommendation,
    };


    try {
      const data = await apiUpsertBook(book);
      state.books = normalizeBooks(data.books || []);
      state.progress = data.progress || [];
      state.modals.editBook = null;
      render();
    } catch (e) {
      state.ui.error = e.message || String(e);
      render();
    }
  }

  async function onSubmitAddProgress() {
    const item = {
      book: getVal("ap_book"),
      startPage: getNum("ap_startPage") || 0,
      endPage: getNum("ap_endPage") || 0,
      startAt: getVal("ap_startAt").trim(),
      endAt: getVal("ap_endAt").trim(),
    };

    try {
      const data = await apiAppendProgress(item);
      state.books = normalizeBooks(data.books || []);
      state.progress = data.progress || [];
      state.modals.addProgress = null;
      render();
    } catch (e) {
      state.ui.error = e.message || String(e);
      render();
    }
  }

  function makeLineGradient(ctx, chartArea) {
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    // ярче сверху, исчезает вниз
    g.addColorStop(0, "rgba(255,255,255,0.18)");
    g.addColorStop(0.55, "rgba(255,255,255,0.06)");
    g.addColorStop(1, "rgba(255,255,255,0.00)");
    return g;
  }
  
  function makeBarGradient(ctx, chartArea) {
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0.35)");
    return g;
  }
  
  function baseChartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        // плавная “дорисовка”
        duration: 900,
        easing: "easeOutQuart",
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          backgroundColor: "rgba(24,24,27,0.92)",
          borderColor: "rgba(255,255,255,0.10)",
          borderWidth: 1,
          titleColor: "rgba(255,255,255,0.90)",
          bodyColor: "rgba(255,255,255,0.80)",
          padding: 10,
          displayColors: false,
          cornerRadius: 10,
          callbacks: {
            label: (ctx) => {
              const metric = state.view.chartMetric || "books";
              const unit = metric === "pages" ? "стр" : "книг";
              const name = ctx.dataset?.label ? `${ctx.dataset.label}: ` : "";
              return ` ${name}${ctx.parsed.y} ${unit}`;
            },
          },          
        },
      },
      interaction: {
        mode: "nearest",
        axis: "x",
        intersect: false,
      },
      scales: {
        x: {
          ticks: {
            color: "rgba(161,161,170,0.85)",
            autoSkip: true,
            autoSkipPadding: 12,
            maxRotation: 0,
            font: { size: 11 },
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
            drawBorder: false,
          },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "rgba(161,161,170,0.85)",
            precision: 0,
            font: { size: 11 },
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
            drawBorder: false,
          },
          border: { display: false },
        },
      },
    };
  }  

  function renderChart() {
    const canvas = qs("#chart");
    if (!canvas) return;
  
    const metric = state.view.chartMetric || "books"; // books | pages
    const dataBooks = chartData();
    const dataPages = chartDataPages();
    const data = metric === "pages" ? dataPages : dataBooks;

    const mode = state.view.chartMode;

    let labels = [];
    let values = [];

    // bar = "months + all years"
    const isBarAllYearsMonths = (mode === "months" && state.view.chartYear === "all");

    if (mode === "years") {
      labels = data.years.map(String);
      values = (metric === "pages") ? data.yearSums : data.yearCounts;
    } else {
      // months
      if (isBarAllYearsMonths) {
        if (metric === "pages") {
          labels = data.timeline.labels;
          values = data.timeline.values;
        } else {
          const completed = state.books.filter(b => normalizeStatus(b.status) === "completed");
          const dates = completed.map(finishDateForBook).filter(Boolean);
          const tl = monthTimelineData(dates);
          labels = tl.labels;
          values = tl.values;
        }
      } else {
        labels = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
        values = (metric === "pages") ? data.monthSums : data.monthCounts;
      }
    }
  
    if (chart) {
      chart.destroy();
      chart = null;
    }
  
    const ctx = canvas.getContext("2d");

    // показываем прошлый год только: months + выбран конкретный год (не all)
    const showPrevYear =
      (mode === "months") &&
      (state.view.chartYear !== "all") &&
      (Number.isFinite(Number(state.view.chartYear ?? data.selectedYear)));

    const selectedYear =
      state.view.chartYear === "all"
        ? null
        : Number(state.view.chartYear ?? data.selectedYear);

    const prevYear = (selectedYear != null) ? (selectedYear - 1) : null;

    let prevValues = null;
    if (showPrevYear && prevYear != null) {
      if (metric === "pages") prevValues = monthSumsPagesForYear(prevYear);
      else prevValues = monthCountsBooksForYear(prevYear);
    }
  
    // создаём график, а градиенты зададим через afterLayout
    // предполагается, что выше уже посчитаны:
    // - labels, values
    // - isBarAllYearsMonths
    // - metric ("books"|"pages")
    // - showPrevYear (boolean)
    // - selectedYear (number|null)
    // - prevYear (number|null)
    // - prevValues (array|null)

    const unitLabel = (metric === "pages") ? "стр" : "книг";

    const mainDataset = {
      // подпись — год, если выбран конкретный, иначе общая
      label: selectedYear ? String(selectedYear) : (metric === "pages" ? "Страницы" : "Книги"),
      data: values,

      // line only
      tension: 0.35,
      cubicInterpolationMode: "monotone",
      fill: !isBarAllYearsMonths,      // заливка только на линии
      borderWidth: isBarAllYearsMonths ? 0 : 2,

      pointRadius: isBarAllYearsMonths ? 0 : 3,
      pointHoverRadius: isBarAllYearsMonths ? 0 : 5,
      pointBorderWidth: isBarAllYearsMonths ? 0 : 2,
      pointBackgroundColor: "rgba(24,24,27,0.95)",
      pointBorderColor: "rgba(255,255,255,0.85)",

      // bar only
      borderRadius: isBarAllYearsMonths ? 10 : 0,
      barThickness: isBarAllYearsMonths ? 14 : undefined,
      maxBarThickness: isBarAllYearsMonths ? 18 : undefined,
    };

    const datasets = [mainDataset];

    // ✅ прошлый год — серой полупрозрачной линией (только в months + выбран год)
    if (showPrevYear && Array.isArray(prevValues)) {
      datasets.push({
        label: String(prevYear),
        data: prevValues,

        // всегда линия, даже если основной — bar (на всякий случай)
        type: "line",
        tension: 0.35,
        cubicInterpolationMode: "monotone",
        fill: false,
        borderWidth: 2,

        borderColor: "rgba(161,161,170,0.45)", // серый полупрозрачный
        backgroundColor: "rgba(0,0,0,0)",
        pointRadius: 0,
        pointHoverRadius: 0,
        borderDash: [4, 4], // убери, если хочешь сплошную
      });
    }

    const cfg = {
      type: isBarAllYearsMonths ? "bar" : "line",
      data: {
        labels,
        datasets,
      },
      options: {
        ...baseChartOptions(),
        // для баров чуть быстрее/упругее
        animation: {
          duration: isBarAllYearsMonths ? 750 : 900,
          easing: isBarAllYearsMonths ? "easeOutCubic" : "easeOutQuart",
        },
        plugins: {
          ...baseChartOptions().plugins,
          // легенду включаем только когда есть прошлый год
          legend: { display: false },
          tooltip: {
            ...baseChartOptions().plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const name = ctx.dataset?.label ? `${ctx.dataset.label}: ` : "";
                return ` ${name}${ctx.parsed.y} ${unitLabel}`;
              },
            },
          },
        },
      },
      plugins: [
        {
          id: "beautifyDataset",
          afterLayout(c) {
            const { ctx, chartArea } = c;
            if (!chartArea) return;

            // красим/градиентим только ОСНОВНОЙ датасет, серый оставляем серым
            const ds = c.data.datasets[0];

            if (isBarAllYearsMonths) {
              ds.backgroundColor = makeBarGradient(ctx, chartArea);
              ds.hoverBackgroundColor = "rgba(255,255,255,0.95)";
            } else {
              ds.borderColor = "rgba(255,255,255,0.90)";
              ds.backgroundColor = makeLineGradient(ctx, chartArea);
            }
          },
        },
      ],
    };

    chart = new Chart(ctx, cfg);

  }

  // ---------- init ----------
  async function init() {
    state.ui.loading = true;
    state.ui.error = null;
    render();

    try {
      const data = await apiSync();
      state.books = normalizeBooks(data.books || []);
      state.progress = data.progress || [];
      state.ui.loading = false;
      render();
    } catch (e) {
      state.ui.loading = false;
      state.ui.error = (e && e.message) ? e.message : String(e);
      render();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAnyModal();
    }
  });
  
  (async () => {
    if (!sessionStorage.getItem(AUTH_KEY)) {
      showAuthModal(true, false);
      return; // не стартуем приложение
    }
    await init();
  })();  
})();

window.addEventListener("load", () => {
  const loader = document.getElementById("app-loader");
  if (!loader) return;

  loader.style.opacity = "0";
  loader.style.transition = "opacity 0.3s ease";

  setTimeout(() => {
    loader.remove();
  }, 300);
});

function waitForReady() {
  const loader = document.getElementById("app-loader");
  if (!loader) return;

  loader.style.opacity = "0";
  loader.style.transition = "opacity 0.3s ease";
  setTimeout(() => loader.remove(), 300);
}

function hideLoader() {
  const loader = document.getElementById("app-loader");
  if (!loader) return;

  loader.style.transition = "opacity 0.25s ease";
  loader.style.opacity = "0";
  setTimeout(() => loader.remove(), 250);
}

// Вариант А: когда DOM и ресурсы прогрузились
window.addEventListener("load", () => {
  hideLoader();
});