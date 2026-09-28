/* ============================================================
   VAULT — Secure Wallet Tracker
   Stage: SUPABASE CONNECTED

   - Login/Signup asal Supabase account banata/check karta hai
     (phone number ko "phone@vault.app" email mein convert kiya jata hai)
   - Login hone par purani history database se load hoti hai
   - Har deposit/withdraw RAM (closure) ke saath-saath database
     mein bhi save hota hai — reload/logout ke baad bhi data rahega

   Agar SUPABASE_URL/SUPABASE_ANON_KEY neeche nahi dali gayi, to app
   automatically "local-only" mode mein chalta hai (testing ke liye).
   ============================================================ */


/* ============================================================
   PART 1: createWallet() — Wahi closure pattern jo humne seekha
   ============================================================ */

function createWallet(startingBalance, initialHistory = []) {
  let history = [...initialHistory];
  let balance = startingBalance;

  const byDate = (a, b) => new Date(a.date) - new Date(b.date);

  // Poori history ko DATE ke hisab se sort karke dobara chalata hai aur har
  // entry ka "balance after" fresh calculate karta hai. Isse add / delete /
  // purani tareekh ki entry (backdate) — teeno ke baad saari entries khud-ba-khud
  // sahi ho jati hain. (Sort stable hai: same waqt wali entries add hone ke
  // order mein hi rehti hain.)
  function recompute() {
    history.sort(byDate);
    let running = startingBalance;
    for (const entry of history) {
      running = entry.type === "deposit" ? running + entry.amount : running - entry.amount;
      entry.balance = running;
    }
    balance = running;
    return running;
  }

  // Kya ye nayi withdrawal kisi bhi point par balance ko negative kar degi?
  // (Us entry ke apne point par, ya baad ki kisi aisi entry par jo pehle theek thi.)
  // Pehle se negative wale points (jaise recurring bills se) ko ignore karta hai.
  function wouldOverdraw(newEntry) {
    const sim = [...history, newEntry].sort(byDate);
    let running = startingBalance;
    for (const e of sim) {
      running += e.type === "deposit" ? e.amount : -e.amount;
      if (running < 0) {
        if (e === newEntry) return true;
        if (e.balance >= 0) return true;
      }
    }
    return false;
  }

  recompute();

  return {
    deposit(id, title, amount, dateISO = new Date().toISOString()) {
      history.push({ id, type: "deposit", title, amount, category: null, date: dateISO, balance: 0 });
      return recompute();
    },
    withdraw(id, title, amount, category = null, dateISO = new Date().toISOString()) {
      const entry = { id, type: "withdraw", title, amount, category, date: dateISO, balance: 0 };
      if (wouldOverdraw(entry)) {
        return null; // insufficient balance — closure khud validate karta hai
      }
      history.push(entry);
      return recompute();
    },
    remove(id) {
      history = history.filter((entry) => entry.id !== id);
      return recompute();
    },
    // Import ke liye: bahut saari entries ek saath (balance check nahi — ye
    // purana record hai) aur sirf ek dafa recompute.
    addMany(entries) {
      for (const e of entries) history.push({ ...e, balance: 0 });
      return recompute();
    },
    // Kya is entry ko hataane se koi aisi entry negative ho jayegi jo pehle theek thi?
    // (delete se pehle user ko warning dene ke liye)
    willGoNegativeWithout(id) {
      let running = startingBalance;
      for (const e of history) {
        if (e.id === id) continue;
        running += e.type === "deposit" ? e.amount : -e.amount;
        if (running < 0 && e.balance >= 0) return true;
      }
      return false;
    },
    removeMany(ids) {
      const drop = new Set(ids);
      history = history.filter((entry) => !drop.has(entry.id));
      return recompute();
    },
    // Recurring bills ke liye — real zindagi mein bhi rent/bill us waqt bhi
    // lagta hai jab account mein poora paisa na ho, isliye ye insufficient-
    // balance check bypass karta hai (manual withdraw() abhi bhi check karta hai).
    forceWithdraw(id, title, amount, category = null) {
      history.push({ id, type: "withdraw", title, amount, category, recurring: true, date: new Date().toISOString(), balance: 0 });
      return recompute();
    },
    getBalance() {
      return balance;
    },
    getHistory() {
      return [...history]; // hamesha ek copy — asal history protected rehti hai
    }
  };
}

// Har naye transaction ko ek client-side unique id deta hai (Supabase ke
// uuid column ke sath compatible), taake delete karte waqt exact entry
// pehchani ja sake.
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) { /* fall through */ }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Har login ke baad, ek fresh wallet banega (abhi ke liye — DB step ke baad
// ye purani history ke saath restore hoga)
let myWallet = null;


/* ============================================================
   PART 2: Security helper — user input ko HTML mein daalne se
   pehle "escape" karna, taake koi bhi <script> jaisa input
   khud chal na jaye
   ============================================================ */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}


/* ============================================================
   PART 3: Supabase setup (abhi disconnected — TODO baad mein)
   ============================================================ */

// TODO (SUPABASE STEP): apna project URL aur anon key yahan daalna
const SUPABASE_URL = 'https://zwaanjcxuwccvummwjny.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_w60KXhq-eH_dfrjCJqtGzA_7OWn5SCN';

let supabaseClient = null;
let isConnected = false;

if (window.supabase && SUPABASE_URL !== 'https://YOUR_PROJECT_REF.supabase.co' && SUPABASE_ANON_KEY) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  isConnected = true;
}


/* ============================================================
   PART 4: DOM references
   ============================================================ */

const authView       = document.getElementById("authView");
const appView         = document.getElementById("appView");
const authForm        = document.getElementById("authForm");
const authSubmitBtn   = document.getElementById("authSubmitBtn");
const authSwitchBtn   = document.getElementById("authSwitchBtn");
const authTitle       = document.getElementById("authTitle");
const authSubtitle    = document.getElementById("authSubtitle");
const authError       = document.getElementById("authError");
const phoneInput      = document.getElementById("phone");
const passwordInput   = document.getElementById("password");
const logoutBtn       = document.getElementById("logoutBtn");
const installBtn      = document.getElementById("installBtn");
const userPhoneDisplay = document.getElementById("userPhoneDisplay");

const balanceFigure = document.getElementById("balanceFigure");
const totalInEl      = document.getElementById("totalIn");
const totalOutEl     = document.getElementById("totalOut");

const btnDeposit  = document.getElementById("btnDeposit");
const btnWithdraw = document.getElementById("btnWithdraw");
const entryForm    = document.getElementById("entryForm");
const titleInput   = document.getElementById("title");
const categoryField = document.getElementById("categoryField");
const categorySelect = document.getElementById("category");
const amountInput  = document.getElementById("amount");
const submitBtn    = document.getElementById("submitBtn");
const submitLabel  = submitBtn.querySelector(".submit-label");
const formError    = document.getElementById("formError");

const ledgerList  = document.getElementById("ledgerList");
const ledgerCount = document.getElementById("ledgerCount");
const emptyState  = document.getElementById("emptyState");
const noMatchState = document.getElementById("noMatchState");

const entryDateInput = document.getElementById("entryDate");
const entryDateLabel = document.querySelector('label[for="entryDate"]');

const ledgerTools     = document.querySelector(".ledger-tools");
const ledgerSearch    = document.getElementById("ledgerSearch");
const ledgerTypeFilter = document.getElementById("ledgerTypeFilter");
const ledgerCategoryFilter = document.getElementById("ledgerCategoryFilter");
const filterSummary   = document.getElementById("filterSummary");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");
const ledgerMoreBtn   = document.getElementById("ledgerMoreBtn");

const exportBtn   = document.getElementById("exportBtn");
const importBtn   = document.getElementById("importBtn");
const importFile  = document.getElementById("importFile");
const dataMessage = document.getElementById("dataMessage");

const budgetsList = document.getElementById("budgetsList");

let deferredInstallPrompt = null;
let isLoginMode = true;
let currentUser = null;
let currentMode = "deposit";

// Budgets state: { Food: 15000, Bills: 8000, ... }. Missing key = no limit set.
let budgets = {};
let editingBudgetCategory = null;

const recurringList = document.getElementById("recurringList");
const recurringForm  = document.getElementById("recurringForm");
const recTitle       = document.getElementById("recTitle");
const recCategory    = document.getElementById("recCategory");
const recAmount      = document.getElementById("recAmount");
const recDay         = document.getElementById("recDay");
const recurringSubmitBtn = document.getElementById("recurringSubmitBtn");
const recurringError = document.getElementById("recurringError");

let recurringRules = []; // [{ id, title, category, amount, day_of_month, active, last_applied }]

/* ============================================================
   PART 4c: Insights (Chart.js) — category breakdown + monthly trend
   ============================================================ */

let categoryChartInstance = null;
let monthlyChartInstance = null;

const rangeCustom      = document.getElementById("rangeCustom");
const rangeFromInput   = document.getElementById("rangeFrom");
const rangeToInput     = document.getElementById("rangeTo");
const rangeApplyBtn    = document.getElementById("rangeApplyBtn");
const rangeError       = document.getElementById("rangeError");
const rangeSummary     = document.getElementById("rangeSummary");
const categoryRangeLabel = document.getElementById("categoryRangeLabel");

// { mode: "month" | "all" | "custom", from: "YYYY-MM-DD"|null, to: "YYYY-MM-DD"|null }
let insightsRange = { mode: "month", from: null, to: null };

const categoryColors = {
  Food: "#ff6b6b",
  Transport: "#5b8cff",
  Bills: "#f3c15f",
  Shopping: "#b388ff",
  Health: "#3ddc97",
  Other: "#94a3c4"
};

function monthLabel(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}

// Kya ye entry selected range ke andar hai? "To" date ka POORA din count hota
// hai (raat 11:59:59 tak), warna aakhri din ka data kat jata.
function isInRange(isoDate, range) {
  if (!isoDate) return false;
  if (range.mode === "all") return true;
  const d = new Date(isoDate);
  if (range.mode === "month") return currentMonthKey(d) === currentMonthKey(new Date());
  if (range.mode === "custom" && range.from && range.to) {
    const from = new Date(range.from + "T00:00:00");
    const to = new Date(range.to + "T23:59:59.999");
    return d >= from && d <= to;
  }
  return true;
}

function rangeLabelText(range) {
  if (range.mode === "month") return "this month";
  if (range.mode === "all") return "all time";
  if (range.mode === "custom" && range.from && range.to) {
    const fmt = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    return `${fmt(range.from)} – ${fmt(range.to)}`;
  }
  return "";
}

function renderInsights(history) {
  // Sirf category chart + summary cards selected range se filter hote hain.
  // Monthly trend neeche poori history se banta hai (uska maqsad hi mahine compare karna hai).
  const filtered = history.filter((e) => isInRange(e.date, insightsRange));

  let totalIn = 0, totalOut = 0;
  const byCategory = {};
  for (const entry of filtered) {
    if (entry.type === "deposit") {
      totalIn += entry.amount;
    } else {
      totalOut += entry.amount;
      const cat = entry.category || "Other";
      byCategory[cat] = (byCategory[cat] || 0) + entry.amount;
    }
  }

  const net = totalIn - totalOut;
  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const topCategory = sortedCats.length ? sortedCats[0][0] : "—";

  rangeSummary.innerHTML = `
    <div class="range-stat"><span class="range-stat-label">In</span><strong class="range-stat-value in">${formatMoney(totalIn)}</strong></div>
    <div class="range-stat"><span class="range-stat-label">Out</span><strong class="range-stat-value out">${formatMoney(totalOut)}</strong></div>
    <div class="range-stat"><span class="range-stat-label">Net</span><strong class="range-stat-value net ${net >= 0 ? "positive" : "negative"}">${net >= 0 ? "+" : "−"}${formatMoney(Math.abs(net))}</strong></div>
    <div class="range-stat"><span class="range-stat-label">Top category</span><strong class="range-stat-value">${escapeHtml(topCategory)}</strong></div>`;

  const label = rangeLabelText(insightsRange);
  categoryRangeLabel.textContent = label ? `(${label})` : "";

  // ---- Category doughnut (withdrawals only, selected range) ----
  const categoryEmpty = document.getElementById("categoryEmpty");
  const categoryCanvas = document.getElementById("categoryChart");
  const catLabels = sortedCats.map(([cat]) => cat);

  // Agar Chart.js load hi nahi hui (internet/CDN block) to baaki app na ruke —
  // summary cards upar ban chuke hain, charts ki jagah ek saaf message.
  if (typeof Chart === "undefined") {
    const monthlyEmptyEl = document.getElementById("monthlyEmpty");
    const monthlyCanvasEl = document.getElementById("monthlyChart");
    const msg = "Charts load nahi hue — internet check karke page reload karo.";
    categoryEmpty.textContent = msg;
    categoryEmpty.style.display = "block";
    categoryCanvas.style.display = "none";
    monthlyEmptyEl.textContent = msg;
    monthlyEmptyEl.style.display = "block";
    monthlyCanvasEl.style.display = "none";
    return;
  }

  if (catLabels.length === 0) {
    categoryEmpty.textContent = "No withdrawals in this range.";
    categoryEmpty.style.display = "block";
    categoryCanvas.style.display = "none";
    if (categoryChartInstance) { categoryChartInstance.destroy(); categoryChartInstance = null; }
  } else {
    categoryEmpty.style.display = "none";
    categoryCanvas.style.display = "block";
    const data = catLabels.map((l) => byCategory[l]);
    const colors = catLabels.map((l) => categoryColors[l] || "#94a3c4");

    if (categoryChartInstance) categoryChartInstance.destroy();
    categoryChartInstance = new Chart(categoryCanvas.getContext("2d"), {
      type: "doughnut",
      data: { labels: catLabels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { color: "#949ebd", boxWidth: 10, font: { size: 11 } } } }
      }
    });
  }

  // ---- Monthly trend (deposits vs withdrawals, bar chart) ----
  const byMonth = {};
  for (const entry of history) {
    if (!entry.date) continue;
    const key = monthLabel(entry.date);
    if (!byMonth[key]) byMonth[key] = { in: 0, out: 0 };
    if (entry.type === "deposit") byMonth[key].in += entry.amount;
    else byMonth[key].out += entry.amount;
  }

  const monthlyEmpty = document.getElementById("monthlyEmpty");
  const monthlyCanvas = document.getElementById("monthlyChart");
  const months = Object.keys(byMonth);

  if (months.length === 0) {
    monthlyEmpty.textContent = "No data yet.";
    monthlyEmpty.style.display = "block";
    monthlyCanvas.style.display = "none";
    if (monthlyChartInstance) { monthlyChartInstance.destroy(); monthlyChartInstance = null; }
  } else {
    monthlyEmpty.style.display = "none";
    monthlyCanvas.style.display = "block";
    const inData = months.map((m) => byMonth[m].in);
    const outData = months.map((m) => byMonth[m].out);

    if (monthlyChartInstance) monthlyChartInstance.destroy();
    monthlyChartInstance = new Chart(monthlyCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: months,
        datasets: [
          { label: "In", data: inData, backgroundColor: "#3ddc97" },
          { label: "Out", data: outData, backgroundColor: "#ff6b6b" }
        ]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { color: "#949ebd", boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: "#949ebd" }, grid: { display: false } },
          y: { ticks: { color: "#949ebd" }, grid: { color: "#ffffff10" }, beginAtZero: true }
        }
      }
    });
  }
}


// ---- Range switcher: This Month / All Time / Custom ----
document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");

    const mode = btn.dataset.range;
    rangeError.textContent = "";

    if (mode === "custom") {
      rangeCustom.classList.add("show");
      // Convenience: khaali ho to current month ki pehli/aakhri tareekh pre-fill
      if (!rangeFromInput.value && !rangeToInput.value) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        rangeFromInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
        rangeToInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
      }
      // Custom ka data Apply dabane par hi badlega
    } else {
      rangeCustom.classList.remove("show");
      insightsRange = { mode, from: null, to: null };
      if (myWallet) renderInsights(myWallet.getHistory());
    }
  });
});

rangeApplyBtn.addEventListener("click", () => {
  const from = rangeFromInput.value;
  const to = rangeToInput.value;

  if (!from || !to) {
    rangeError.textContent = "Dono dates select karo (From aur To).";
    return;
  }
  if (from > to) {
    rangeError.textContent = "'From' date, 'To' date se pehle honi chahiye.";
    return;
  }

  rangeError.textContent = "";
  insightsRange = { mode: "custom", from, to };
  if (myWallet) renderInsights(myWallet.getHistory());
});


/* ============================================================
   PART 4d: Budgets — per-category monthly limits
   ============================================================ */

const BUDGET_CATEGORIES = ["Food", "Transport", "Bills", "Shopping", "Health", "Other"];

// "YYYY-MM" key — sirf isi se hum "is mahine ka kharcha" nikalte hain.
// Koi cron/reset job ki zaroorat nahi: mahina badalte hi purane
// transactions apne aap alag mahine mein chale jate hain, current-month
// ka total apne aap sirf naye mahine ke transactions se ban jata hai.
function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function loadBudgetsFromDatabase() {
  if (!isConnected) return {};

  const { data, error } = await supabaseClient
    .from("budgets")
    .select("category, monthly_limit")
    .eq("user_id", currentUser.id);

  if (error) {
    console.error("Budgets load failed:", error.message);
    return {};
  }

  const result = {};
  for (const row of data) result[row.category] = Number(row.monthly_limit);
  return result;
}

function renderBudgets(history) {
  const monthNow = currentMonthKey();
  const spentByCategory = {};

  for (const entry of history) {
    if (entry.type !== "withdraw" || !entry.date) continue;
    if (currentMonthKey(new Date(entry.date)) !== monthNow) continue;
    const cat = entry.category || "Other";
    spentByCategory[cat] = (spentByCategory[cat] || 0) + entry.amount;
  }

  budgetsList.innerHTML = BUDGET_CATEGORIES.map((cat) => {
    const limit = budgets[cat];
    const spent = spentByCategory[cat] || 0;
    const color = categoryColors[cat] || "#94a3c4";
    const isEditing = editingBudgetCategory === cat;

    let right, bar = "";

    if (isEditing) {
      right = `
        <span class="budget-edit-form">
          <input type="number" min="1" step="1" id="budgetInput" placeholder="e.g. 15000" value="${limit || ""}">
          <button type="button" class="budget-save" data-category="${cat}">Save</button>
          ${limit ? `<button type="button" class="budget-remove" data-category="${cat}">Remove</button>` : ""}
          <button type="button" class="budget-cancel">Cancel</button>
        </span>`;
    } else if (limit) {
      const pct = Math.min(100, Math.round((spent / limit) * 100));
      const barColor = pct >= 100 ? "var(--red)" : pct >= 80 ? "#f3c15f" : "var(--green)";
      const overBy = spent > limit ? spent - limit : 0;
      right = `
        <span class="budget-amounts">${formatMoney(spent)} / ${formatMoney(limit)}</span>
        <button type="button" class="budget-edit-btn" data-category="${cat}">Edit</button>`;
      bar = `
        <div class="budget-bar-track"><div class="budget-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
        ${overBy > 0 ? `<span class="budget-over">Over by ${formatMoney(overBy)}</span>` : ""}`;
    } else {
      right = `<button type="button" class="budget-edit-btn" data-category="${cat}">Set limit</button>`;
    }

    return `
      <div class="budget-row">
        <div class="budget-row-top">
          <span class="budget-cat"><span class="budget-dot" style="background:${color}"></span>${cat}</span>
          ${right}
        </div>
        ${bar}
      </div>`;
  }).join("");
}

async function saveBudget(category) {
  const input = document.getElementById("budgetInput");
  const value = Number(input.value);

  if (!value || value <= 0) {
    alert("Enter a valid amount greater than 0.");
    return;
  }

  budgets[category] = value;
  editingBudgetCategory = null;

  if (isConnected) {
    try {
      const { error } = await supabaseClient
        .from("budgets")
        .upsert({ user_id: currentUser.id, category, monthly_limit: value }, { onConflict: "user_id,category" });
      if (error) formError.textContent = "Failed to save budget: " + error.message;
    } catch (err) {
      formError.textContent = "Something went wrong saving the budget.";
    }
  }

  renderBudgets(myWallet.getHistory());
}

async function removeBudget(category) {
  delete budgets[category];
  editingBudgetCategory = null;

  if (isConnected) {
    try {
      const { error } = await supabaseClient
        .from("budgets")
        .delete()
        .eq("user_id", currentUser.id)
        .eq("category", category);
      if (error) formError.textContent = "Failed to remove budget: " + error.message;
    } catch (err) {
      formError.textContent = "Something went wrong removing the budget.";
    }
  }

  renderBudgets(myWallet.getHistory());
}

budgetsList.addEventListener("click", (e) => {
  const editBtn = e.target.closest(".budget-edit-btn");
  if (editBtn) {
    editingBudgetCategory = editBtn.dataset.category;
    renderBudgets(myWallet.getHistory());
    document.getElementById("budgetInput")?.focus();
    return;
  }
  const cancelBtn = e.target.closest(".budget-cancel");
  if (cancelBtn) {
    editingBudgetCategory = null;
    renderBudgets(myWallet.getHistory());
    return;
  }
  const saveBtn = e.target.closest(".budget-save");
  if (saveBtn) { saveBudget(saveBtn.dataset.category); return; }
  const removeBtn = e.target.closest(".budget-remove");
  if (removeBtn) { removeBudget(removeBtn.dataset.category); }
});


/* ============================================================
   PART 4e: Recurring Bills — fixed monthly kharche auto-add karna
   ============================================================ */

async function loadRecurringRulesFromDatabase() {
  if (!isConnected) return [];

  const { data, error } = await supabaseClient
    .from("recurring_rules")
    .select("id, title, category, amount, day_of_month, active, last_applied")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Recurring rules load failed:", error.message);
    return [];
  }

  return data.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    amount: Number(r.amount),
    day_of_month: r.day_of_month,
    active: r.active,
    last_applied: r.last_applied
  }));
}

// Login/app-open hote hi chalta hai: jo bhi active rule "due" hai (uski date
// aa chuki hai aur is mahine abhi tak apply nahi hui), uska transaction
// khud add kar deta hai. Pichle chhoote hue mahinon ko "backfill" nahi
// karta — sirf current month check hota hai.
async function applyDueRecurringRules() {
  const today = new Date();
  const todayDay = today.getDate();
  const monthNow = currentMonthKey(today);
  const todayStr = localDateStr(today);

  for (const rule of recurringRules) {
    if (!rule.active) continue;

    // last_applied "YYYY-MM-DD" hai — local date ki tarah parse karte hain (UTC nahi)
    const appliedMonth = rule.last_applied
      ? currentMonthKey(new Date(String(rule.last_applied).slice(0, 10) + "T00:00:00"))
      : null;
    if (appliedMonth === monthNow) continue;    // is mahine already lag chuka hai
    if (todayDay < rule.day_of_month) continue; // abhi tareekh aayi hi nahi

    const id = generateId();
    myWallet.forceWithdraw(id, rule.title, rule.amount, rule.category);

    if (isConnected) {
      const entry = myWallet.getHistory().find((x) => x.id === id);
      const previousApplied = rule.last_applied;

      // Pehle "is mahine lag gaya" mark karte hain, phir transaction insert.
      // Agar insert fail ho to mark wapas hata dete hain — is tarah na duplicate
      // bill banta hai, na koi bill chup-chaap miss hota hai.
      const { error: markError } = await supabaseClient
        .from("recurring_rules").update({ last_applied: todayStr }).eq("id", rule.id);
      if (markError) {
        console.error("Recurring mark failed:", markError.message);
        myWallet.remove(id);
        continue;
      }

      const { error: insertError } = await supabaseClient.from("transactions").insert([{
        id: entry.id,
        user_id: currentUser.id,
        type: entry.type,
        title: entry.title,
        amount: entry.amount,
        category: entry.category,
        is_recurring: true,
        created_at: entry.date,
        balance: entry.balance
      }]);

      if (insertError) {
        console.error("Recurring insert failed:", insertError.message);
        myWallet.remove(id);
        await supabaseClient.from("recurring_rules").update({ last_applied: previousApplied }).eq("id", rule.id);
        continue;
      }
    }

    rule.last_applied = todayStr;
  }
}

function renderRecurring() {
  if (recurringRules.length === 0) {
    recurringList.innerHTML = `<p class="recurring-empty-text">No recurring bills yet — add one below.</p>`;
    return;
  }

  recurringList.innerHTML = recurringRules.map((rule) => {
    const color = categoryColors[rule.category] || "#94a3c4";
    return `
      <div class="recurring-row ${rule.active ? "" : "paused"}">
        <div class="recurring-row-main">
          <span class="recurring-dot" style="background:${color}"></span>
          <span class="recurring-info">
            <span class="recurring-title">${escapeHtml(rule.title)}</span>
            <span class="recurring-meta">${escapeHtml(rule.category)} · Day ${rule.day_of_month} · ${formatMoney(rule.amount)}</span>
          </span>
        </div>
        <div class="recurring-row-actions">
          <button type="button" class="toggle-switch ${rule.active ? "on" : ""}" data-id="${rule.id}"
                  role="switch" aria-checked="${rule.active}" aria-label="Toggle ${escapeHtml(rule.title)}">
            <span class="toggle-knob"></span>
          </button>
          <button type="button" class="item-delete" data-id="${rule.id}" aria-label="Delete rule" title="Delete rule">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join("");
}

recurringForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = recTitle.value.trim();
  const category = recCategory.value;
  const amount = Number(recAmount.value);
  const day = Number(recDay.value);

  if (!title || !amount || amount <= 0 || !day || day < 1 || day > 28) {
    recurringError.textContent = "Sab fields sahi bharo (day 1–28 ke beech).";
    return;
  }

  recurringSubmitBtn.disabled = true;
  recurringError.textContent = "";

  const newRule = { id: generateId(), title, category, amount, day_of_month: day, active: true, last_applied: null };

  try {
    if (isConnected) {
      const { error } = await supabaseClient.from("recurring_rules").insert([{
        id: newRule.id,
        user_id: currentUser.id,
        title, category, amount,
        day_of_month: day,
        active: true
      }]);
      if (error) throw error;
    }
    recurringRules.push(newRule);
    renderRecurring();
    recurringForm.reset();
    recCategory.value = "Bills";
  } catch (err) {
    recurringError.textContent = err.message || "Rule save nahi ho saki.";
  } finally {
    recurringSubmitBtn.disabled = false;
  }
});

recurringList.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".toggle-switch");
  if (toggleBtn) {
    const id = toggleBtn.dataset.id;
    const rule = recurringRules.find((r) => r.id === id);
    if (!rule) return;
    rule.active = !rule.active;
    renderRecurring();
    if (isConnected) {
      const { error } = await supabaseClient.from("recurring_rules").update({ active: rule.active }).eq("id", id);
      if (error) { rule.active = !rule.active; renderRecurring(); } // revert on failure
    }
    return;
  }

  const deleteBtn = e.target.closest(".item-delete");
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    if (!confirm("Delete this recurring rule? Past transactions it already created will stay.")) return;
    deleteBtn.disabled = true;
    if (isConnected) {
      const { error } = await supabaseClient.from("recurring_rules").delete().eq("id", id).eq("user_id", currentUser.id);
      if (error) { deleteBtn.disabled = false; return; }
    }
    recurringRules = recurringRules.filter((r) => r.id !== id);
    renderRecurring();
  }
});


/* ============================================================
   PART 4b: Database se purani history load karna
   ============================================================ */

async function loadTransactionsFromDatabase(userId) {
  // Supabase ek query mein default 1000 rows deta hai — isliye pages mein
  // load karte hain, warna 1000 se zyada entries hone par purani silently
  // gayab ho jati aur balance galat dikhta.
  const PAGE_SIZE = 1000;
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from("transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    // Finance app mein adhoori history dikhana khatarnaak hai (galat balance) —
    // isliye yahan error throw karte hain, login screen par saaf message aata hai.
    if (error) throw new Error("History load nahi ho saki: " + error.message);

    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  // Database ke rows ko wahi shape dete hain jo createWallet expect karta hai
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    amount: Number(row.amount),
    category: row.category || null,
    recurring: !!row.is_recurring,
    date: row.created_at,
    balance: Number(row.balance)
  }));
}


/* ============================================================
   PART 5: View switching (Auth screen ↔ App screen)
   ============================================================ */

function showApp() {
  authView.classList.remove("active-view");
  authView.classList.add("hidden-view");
  appView.classList.remove("hidden-view");
  appView.classList.add("active-view");
  refreshEntryDate(true);
  render();
}

function showAuth() {
  appView.classList.remove("active-view");
  appView.classList.add("hidden-view");
  authView.classList.remove("hidden-view");
  authView.classList.add("active-view");
  phoneInput.value = "";
  passwordInput.value = "";
  authError.textContent = "";
}


/* ============================================================
   PART 6: Auth logic
   ============================================================ */

authSwitchBtn.addEventListener("click", () => {
  isLoginMode = !isLoginMode;
  authTitle.textContent = isLoginMode ? "Welcome Back" : "Create Vault";
  authSubtitle.textContent = isLoginMode
    ? "Enter your details to access your vault"
    : "Choose a phone number and password to get started";
  authSubmitBtn.querySelector(".submit-label").textContent = isLoginMode ? "Login" : "Sign Up";
  authSwitchBtn.parentElement.firstChild.textContent = isLoginMode
    ? "Don't have an account? "
    : "Already have an account? ";
  authSwitchBtn.textContent = isLoginMode ? "Sign Up" : "Login";
  authError.textContent = "";
});

// Keyboard access — Enter/Space par bhi switch ho (role="button" hai, native button nahi)
authSwitchBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    authSwitchBtn.click();
  }
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const phone = phoneInput.value.trim();
  const password = passwordInput.value;

  if (!phone || !password) {
    authError.textContent = "Phone aur password dono zaroori hain.";
    return;
  }
  if (password.length < 6) {
    authError.textContent = "Password kam se kam 6 characters ka ho.";
    return;
  }

  authSubmitBtn.disabled = true;
  authSubmitBtn.querySelector(".submit-label").textContent = "Processing...";
  authError.textContent = "";

  try {
    if (isConnected) {
      // Supabase phone-based auth free tier mein nahi hai, isliye phone
      // number ko ek "fake" email mein convert kar rahe hain — sirf
      // Supabase ko batane ke liye ek unique account hai, user ko ye
      // email kabhi dikhta ya use karna nahi padta
      const email = `${phone}@vault.app`;

      const authResponse = isLoginMode
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password });

      if (authResponse.error) throw authResponse.error;

      currentUser = authResponse.data.user;

      const savedHistory = await loadTransactionsFromDatabase(currentUser.id);
      myWallet = createWallet(0, savedHistory);
      budgets = await loadBudgetsFromDatabase();
      recurringRules = await loadRecurringRulesFromDatabase();
      await applyDueRecurringRules();
    } else {
      // Supabase abhi connect nahi hai (URL/Key nahi dali) — local-only mode
      currentUser = { phone };
      myWallet = createWallet(0);
      budgets = {};
      recurringRules = [];
    }

    userPhoneDisplay.textContent = phone;
    showApp();
  } catch (error) {
    authError.textContent = error.message || "Something went wrong.";
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.querySelector(".submit-label").textContent = isLoginMode ? "Login" : "Sign Up";
  }
});

logoutBtn.addEventListener("click", async () => {
  if (isConnected) await supabaseClient.auth.signOut();
  currentUser = null;
  myWallet = null;
  budgets = {};
  editingBudgetCategory = null;
  recurringRules = [];
  resetLedgerFilters();
  dataMessage.textContent = "";
  dataMessage.className = "data-message";
  insightsRange = { mode: "month", from: null, to: null };
  rangeCustom.classList.remove("show");
  rangeFromInput.value = "";
  rangeToInput.value = "";
  document.querySelectorAll(".range-btn").forEach((b) => {
    const isMonth = b.dataset.range === "month";
    b.classList.toggle("active", isMonth);
    b.setAttribute("aria-selected", String(isMonth));
  });
  showAuth();
});


/* ============================================================
   PART 7: Helpers
   ============================================================ */

function formatMoney(n) {
  return "Rs " + n.toLocaleString("en-PK");
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-PK", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// Device ki apni timezone ka "YYYY-MM-DD". (toISOString() UTC deta hai — Pakistan
// mein raat ke waqt wo pichla din ban jata hai, isliye date-only kaam ke liye
// hamesha ye helper use karo.)
function localDateStr(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// Date input ("YYYY-MM-DD") ko ISO timestamp mein badalta hai. Aaj ki date ho to
// abhi ka waqt; purani date ho to us din par abhi wala time-of-day.
function dateInputToISO(dateStr) {
  const now = new Date();
  if (!dateStr || dateStr === localDateStr(now)) return now.toISOString();
  const d = new Date(dateStr + "T00:00:00");
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  return d.toISOString();
}

function computeTotals(history) {
  let totalIn = 0;
  let totalOut = 0;
  for (const entry of history) {
    if (entry.type === "deposit") totalIn += entry.amount;
    else totalOut += entry.amount;
  }
  return { totalIn, totalOut };
}


/* ============================================================
   PART 8: Render — screen ko wallet ke current state se update karna
   ============================================================ */

// ---- Ledger: search + filters + "Show more" ----
const LEDGER_PAGE_SIZE = 50;
let ledgerLimit = LEDGER_PAGE_SIZE;
let ledgerFilter = { text: "", type: "all", category: "all" };

function isFilterActive() {
  return !!ledgerFilter.text || ledgerFilter.type !== "all" || ledgerFilter.category !== "all";
}

function entryMatchesFilter(entry) {
  const f = ledgerFilter;
  if (f.type === "deposit" && entry.type !== "deposit") return false;
  if (f.type === "withdraw" && entry.type !== "withdraw") return false;
  if (f.type === "recurring" && !entry.recurring) return false;
  if (f.category !== "all") {
    if (entry.type !== "withdraw") return false;
    if ((entry.category || "Other") !== f.category) return false;
  }
  if (f.text) {
    const haystack = `${entry.title} ${entry.category || ""} ${entry.amount}`.toLowerCase();
    if (!haystack.includes(f.text)) return false;
  }
  return true;
}

function renderLedger(history) {
  const total = history.length;

  // "#" number entry ki asal position se aata hai (filter se nahi badalta)
  const matches = [];
  history.forEach((entry, i) => {
    if (entryMatchesFilter(entry)) matches.push({ entry, number: i + 1 });
  });
  matches.reverse(); // naye upar
  const visible = matches.slice(0, ledgerLimit);

  const fragment = document.createDocumentFragment();
  for (const { entry, number } of visible) {
    const li = document.createElement("li");
    li.className = "ledger-item";

    const sign = entry.type === "deposit" ? "+" : "−";
    const icon = entry.type === "deposit" ? "↑" : "↓";

    li.innerHTML = `
      <span class="item-index">#${number}</span>
      <span class="item-icon ${entry.type}">${icon}</span>
      <span class="item-body">
        <span class="item-title">${escapeHtml(entry.title)}</span>
        <span class="item-meta">${entry.recurring ? '<span class="tag-recurring">Recurring</span> · ' : ""}${entry.category ? escapeHtml(entry.category) + " · " : ""}${formatDateTime(entry.date)} · Balance after: ${formatMoney(entry.balance)}</span>
      </span>
      <span class="item-amount ${entry.type}">${sign} ${formatMoney(entry.amount)}</span>
      <button type="button" class="item-delete" data-id="${entry.id}" aria-label="Delete entry" title="Delete entry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>
        </svg>
      </button>
    `;
    fragment.appendChild(li);
  }
  ledgerList.innerHTML = "";
  ledgerList.appendChild(fragment);

  const filtering = isFilterActive();
  ledgerCount.textContent = filtering
    ? `${matches.length} of ${total} ${total === 1 ? "entry" : "entries"}`
    : `${total} ${total === 1 ? "entry" : "entries"}`;

  // Filter active ho to matched entries ka apna In/Out total bhi dikhao
  if (filtering && matches.length > 0) {
    let fin = 0, fout = 0;
    for (const { entry } of matches) {
      if (entry.type === "deposit") fin += entry.amount; else fout += entry.amount;
    }
    filterSummary.textContent = `In ${formatMoney(fin)} · Out ${formatMoney(fout)}`;
  } else {
    filterSummary.textContent = "";
  }
  clearFiltersBtn.hidden = !filtering;

  const remaining = matches.length - visible.length;
  ledgerMoreBtn.hidden = remaining <= 0;
  ledgerMoreBtn.textContent = `Show more (${remaining} left)`;

  ledgerTools.hidden = total === 0;
  emptyState.classList.toggle("show", total === 0);
  noMatchState.classList.toggle("show", total > 0 && matches.length === 0);
}

function refreshLedger() {
  if (myWallet) renderLedger(myWallet.getHistory());
}

ledgerSearch.addEventListener("input", () => {
  ledgerFilter.text = ledgerSearch.value.trim().toLowerCase();
  ledgerLimit = LEDGER_PAGE_SIZE;
  refreshLedger();
});
ledgerTypeFilter.addEventListener("change", () => {
  ledgerFilter.type = ledgerTypeFilter.value;
  ledgerLimit = LEDGER_PAGE_SIZE;
  refreshLedger();
});
ledgerCategoryFilter.addEventListener("change", () => {
  ledgerFilter.category = ledgerCategoryFilter.value;
  ledgerLimit = LEDGER_PAGE_SIZE;
  refreshLedger();
});
clearFiltersBtn.addEventListener("click", () => {
  resetLedgerFilters();
  refreshLedger();
});
ledgerMoreBtn.addEventListener("click", () => {
  ledgerLimit += LEDGER_PAGE_SIZE;
  refreshLedger();
});

function resetLedgerFilters() {
  ledgerFilter = { text: "", type: "all", category: "all" };
  ledgerLimit = LEDGER_PAGE_SIZE;
  ledgerSearch.value = "";
  ledgerTypeFilter.value = "all";
  ledgerCategoryFilter.value = "all";
}

function render() {
  if (!myWallet) return;

  const balance = myWallet.getBalance();
  const history = myWallet.getHistory();
  const { totalIn, totalOut } = computeTotals(history);

  balanceFigure.textContent = formatMoney(balance);
  totalInEl.textContent = formatMoney(totalIn);
  totalOutEl.textContent = formatMoney(totalOut);

  balanceFigure.classList.remove("pulse");
  void balanceFigure.offsetWidth;
  balanceFigure.classList.add("pulse");

  // Har section apne try/catch mein — ek section (jaise charts) fail ho to
  // baaki (ledger, budgets, recurring) phir bhi sahi dikhein.
  for (const section of [renderLedger, renderInsights, renderBudgets]) {
    try { section(history); } catch (err) { console.error(`${section.name} failed:`, err); }
  }
  try { renderRecurring(); } catch (err) { console.error("renderRecurring failed:", err); }
}


/* ============================================================
   PART 9: Deposit/Withdraw toggle
   ============================================================ */

function setMode(mode) {
  currentMode = mode;
  btnDeposit.classList.toggle("active", mode === "deposit");
  btnWithdraw.classList.toggle("active", mode === "withdraw");
  btnDeposit.setAttribute("aria-selected", mode === "deposit");
  btnWithdraw.setAttribute("aria-selected", mode === "withdraw");
  submitLabel.textContent = mode === "deposit" ? "Add Deposit" : "Add Withdrawal";
  submitBtn.classList.toggle("withdraw-mode", mode === "withdraw");
  titleInput.placeholder = mode === "deposit"
    ? "e.g. Freelance payment, Gift"
    : "e.g. Groceries, Rent";
  categoryField.style.display = mode === "withdraw" ? "block" : "none";
  formError.textContent = "";
}

btnDeposit.addEventListener("click", () => setMode("deposit"));
btnWithdraw.addEventListener("click", () => setMode("withdraw"));


/* ============================================================
   PART 10: Deposit/Withdraw form submit
   ============================================================ */

// Date field: max = aaj, aur agar purani date chuni ho to label mein saaf dikhao
function refreshEntryDate(resetToToday = false) {
  const today = localDateStr();
  entryDateInput.max = today;
  if (resetToToday || !entryDateInput.value) entryDateInput.value = today;
  updateDateHint();
}

function updateDateHint() {
  const backdated = !!entryDateInput.value && entryDateInput.value < localDateStr();
  entryDateLabel.textContent = backdated ? "Date · backdated entry" : "Date";
  entryDateLabel.style.color = backdated ? "var(--gold)" : "";
}

entryDateInput.addEventListener("input", updateDateHint);
entryDateInput.addEventListener("change", updateDateHint);

entryForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = titleInput.value.trim();
  const amount = Number(amountInput.value);
  const category = currentMode === "withdraw" ? categorySelect.value : null;
  const todayStr = localDateStr();
  const dateStr = entryDateInput.value || todayStr;
  const isToday = dateStr === todayStr;
  const newId = generateId();

  if (!title || !amount || amount <= 0) {
    formError.textContent = "Enter a valid title and amount.";
    return;
  }
  if (title.length > 120) {
    formError.textContent = "Title 120 characters se chhota rakho.";
    return;
  }
  if (dateStr > todayStr) {
    formError.textContent = "Future ki date allowed nahi hai.";
    return;
  }

  const dateISO = dateInputToISO(dateStr);

  submitBtn.disabled = true;
  submitLabel.textContent = "Saving...";

  try {
    if (currentMode === "deposit") {
      myWallet.deposit(newId, title, amount, dateISO);
    } else {
      const result = myWallet.withdraw(newId, title, amount, category, dateISO);
      if (result === null) {
        formError.textContent = isToday
          ? "Insufficient balance for this withdrawal."
          : "Us date par itna balance nahi tha (ya baad ki entries negative ho jayengi).";
        return;
      }
    }

    if (isConnected) {
      // Sorting ki wajah se nayi entry aakhri position par hone ki guarantee
      // nahi (backdate), isliye id se dhundhte hain
      const entry = myWallet.getHistory().find((x) => x.id === newId);

      let saveError = null;
      try {
        const { error } = await supabaseClient.from("transactions").insert([
          {
            id: entry.id,
            user_id: currentUser.id,
            type: entry.type,
            title: entry.title,
            amount: entry.amount,
            category: entry.category,
            created_at: entry.date,
            balance: entry.balance
          }
        ]);
        saveError = error;
      } catch (err) {
        saveError = err;
      }

      if (saveError) {
        // Database mein save nahi hua to local mein bhi nahi rakhte — warna
        // balance screen par alag aur asal mein alag hota (reload par entry gayab).
        // Form ki values wahin rehti hain taake user dobara try kar sake.
        myWallet.remove(newId);
        formError.textContent = "Save nahi ho saka (internet check karo), dobara try karo. " + (saveError.message || "");
        render();
        return;
      }
    }

    formError.textContent = "";
    titleInput.value = "";
    amountInput.value = "";
    titleInput.focus();
    render();
  } finally {
    submitBtn.disabled = false;
    submitLabel.textContent = currentMode === "deposit" ? "Add Deposit" : "Add Withdrawal";
  }
});


/* ============================================================
   PART 10b: Delete an entry (with confirmation)
   ============================================================ */

ledgerList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".item-delete");
  if (!btn) return;

  const id = btn.dataset.id;
  const risky = myWallet.willGoNegativeWithout(id);
  const confirmed = confirm(
    risky
      ? "Is entry ko hataane se baad ki kuch entries ka balance minus (negative) mein chala jayega.\n\nPhir bhi delete karna hai? Ye wapas nahi hoga."
      : "Delete this entry? This can't be undone."
  );
  if (!confirmed) return;

  btn.disabled = true;

  try {
    if (isConnected) {
      const { error } = await supabaseClient
        .from("transactions")
        .delete()
        .eq("id", id)
        .eq("user_id", currentUser.id);

      if (error) {
        formError.textContent = "Failed to delete: " + error.message;
        btn.disabled = false;
        return;
      }
    }
    myWallet.remove(id);
    render();
  } catch (err) {
    formError.textContent = "Something went wrong while deleting.";
    btn.disabled = false;
  }
});


/* ============================================================
   PART 10c: Backup — CSV export / import
   ============================================================ */

const CSV_COLUMNS = ["date", "type", "title", "category", "amount", "recurring", "balance_after"];
const IMPORT_MAX_ROWS = 2000;
const IMPORT_MAX_BYTES = 1024 * 1024; // 1 MB
const TITLE_MAX = 120;

function setDataMessage(text, kind = "") {
  dataMessage.textContent = text;
  dataMessage.className = "data-message" + (kind ? " " + kind : "");
}

// Text cell: comma/quote/newline ho to quotes mein band karta hai. "guard" on ho to
// jo text = + - @ se shuru ho use ' laga deta hai, taake Excel usse formula samajh
// kar chala na de (CSV injection). Import mein ye ' wapas hata diya jata hai.
function csvCell(value, guard = false) {
  let s = value == null ? "" : String(value);
  if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(history) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of history) {
    lines.push([
      new Date(e.date).toISOString(),
      e.type,
      csvCell(e.title, true),
      csvCell(e.category || "", true),
      e.amount,
      e.recurring ? "true" : "false",
      e.balance
    ].join(","));
  }
  // \uFEFF (BOM) — taake Excel Urdu/Unicode titles sahi kholay
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ";" : ","; // kuch Excel locales ; use karte hain
}

// Chhota RFC-4180 parser: quotes, "" escape, quotes ke andar comma/newline, CRLF.
function parseCsv(text, delimiter = ",") {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row); // bilkul khaali lines skip
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) pushRow();
  return rows;
}

function entrySignature(date, type, amount, title) {
  return `${new Date(date).getTime()}|${type}|${Number(amount)}|${String(title).trim().toLowerCase()}`;
}

function unguardCell(s) {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s; // export ne jo ' lagaya tha
}

function parseImportDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Sirf date ho (waqt nahi) to us din ka dopahar 12:00 (local) le lete hain
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T12:00:00") : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// File ko parse + validate karta hai (kuch save nahi karta). Duplicates sirf
// PEHLE se maujood entries ke against dekhe jate hain (same date-time, type,
// amount, title) — is liye wahi file dobara import karo to kuch double nahi hoga.
function analyzeImport(text, existingHistory) {
  const result = { valid: [], errors: [], invalid: 0, duplicates: 0, total: 0 };

  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length < 2) {
    result.errors.push("File khaali hai ya sirf header hai.");
    return result;
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const missing = ["date", "type", "title", "amount"].filter((n) => col(n) === -1);
  if (missing.length) {
    result.errors.push("Zaroori columns nahi mile: " + missing.join(", ") + ". Pehli row header honi chahiye (Export wali file ka format).");
    return result;
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) {
    result.errors.push(`Ek dafa mein max ${IMPORT_MAX_ROWS} rows import ho sakti hain (is file mein ${dataRows.length} hain).`);
    return result;
  }
  result.total = dataRows.length;

  const cDate = col("date"), cType = col("type"), cTitle = col("title");
  const cCat = col("category"), cAmount = col("amount"), cRec = col("recurring");

  const existing = new Set(existingHistory.map((e) => entrySignature(e.date, e.type, e.amount, e.title)));
  const now = Date.now();

  dataRows.forEach((r, i) => {
    const line = i + 2; // header = row 1
    const fail = (why) => {
      result.invalid++;
      if (result.errors.length < 5) result.errors.push(`Row ${line}: ${why}`);
    };

    const typeRaw = String(r[cType] || "").trim().toLowerCase();
    const type = typeRaw === "deposit" ? "deposit"
      : (typeRaw === "withdraw" || typeRaw === "withdrawal") ? "withdraw" : null;
    if (!type) return fail("type 'deposit' ya 'withdraw' hona chahiye");

    const title = unguardCell(String(r[cTitle] || "").trim());
    if (!title) return fail("title khaali hai");
    if (title.length > TITLE_MAX) return fail(`title ${TITLE_MAX} characters se lamba hai`);

    const amount = Math.round(Number(String(r[cAmount] || "").replace(/rs\.?|,|\s/gi, "")) * 100) / 100;
    if (!isFinite(amount) || amount <= 0 || amount > 1e9) return fail("amount sahi number (0 se bada) hona chahiye");

    const d = parseImportDate(r[cDate]);
    if (!d) return fail("date samajh nahi aayi (YYYY-MM-DD chahiye)");
    if (d.getTime() > now + 60000) return fail("date future ki hai");

    let category = null;
    if (type === "withdraw") {
      const raw = cCat === -1 ? "" : unguardCell(String(r[cCat] || "").trim());
      category = BUDGET_CATEGORIES.find((c) => c.toLowerCase() === raw.toLowerCase()) || "Other";
    }
    const recurring = cRec !== -1 && /^(true|1|yes)$/i.test(String(r[cRec] || "").trim());

    const dateISO = d.toISOString();
    if (existing.has(entrySignature(dateISO, type, amount, title))) {
      result.duplicates++;
      return;
    }
    result.valid.push({ id: generateId(), type, title, amount, category, recurring, date: dateISO });
  });

  return result;
}

// Entries ko wallet mein aur (connected ho to) database mein 100-100 ke batch mein
// save karta hai. Kisi batch mein error aaye to bache hue (na-save) wapas hata deta hai.
async function importEntries(entries) {
  myWallet.addMany(entries);
  if (!isConnected) return { saved: entries.length, failed: 0 };

  const balanceById = new Map(myWallet.getHistory().map((e) => [e.id, e.balance]));
  const BATCH = 100;
  let saved = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const rows = chunk.map((e) => ({
      id: e.id,
      user_id: currentUser.id,
      type: e.type,
      title: e.title,
      amount: e.amount,
      category: e.category,
      is_recurring: !!e.recurring,
      created_at: e.date,
      balance: balanceById.get(e.id)
    }));

    let failure = null;
    try {
      const { error } = await supabaseClient.from("transactions").insert(rows);
      failure = error;
    } catch (err) {
      failure = err;
    }

    if (failure) {
      myWallet.removeMany(entries.slice(i).map((e) => e.id));
      return { saved, failed: entries.length - saved, message: failure.message };
    }
    saved += chunk.length;
  }
  return { saved, failed: 0 };
}

exportBtn.addEventListener("click", () => {
  if (!myWallet) return;
  const history = myWallet.getHistory();
  if (history.length === 0) {
    setDataMessage("Export karne ke liye abhi koi entry nahi hai.", "error");
    return;
  }
  downloadTextFile(`vault-export-${localDateStr()}.csv`, buildCsv(history), "text/csv;charset=utf-8");
  setDataMessage(`${history.length} entries export ho gayin (vault-export-${localDateStr()}.csv).`, "ok");
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = ""; // taake wahi file dobara select ho sake
  if (!file || !myWallet) return;

  if (file.size > IMPORT_MAX_BYTES) {
    setDataMessage("File 1 MB se badi hai — chhoti files mein tod kar import karo.", "error");
    return;
  }

  importBtn.disabled = true;
  exportBtn.disabled = true;
  setDataMessage("File check ho rahi hai...");

  try {
    const text = await file.text();
    const result = analyzeImport(text, myWallet.getHistory());

    const problems = result.errors.length ? "\n• " + result.errors.join("\n• ") : "";

    if (result.valid.length === 0) {
      const why = result.total === 0
        ? "Import nahi ho saka."
        : `Koi nayi entry nahi mili (${result.duplicates} pehle se maujood, ${result.invalid} galat).`;
      setDataMessage(why + problems, "error");
      return;
    }

    const ok = confirm(
      `${result.valid.length} nayi entries import hongi.\n` +
      `${result.duplicates} pehle se maujood (skip), ${result.invalid} galat rows (skip).\n\nContinue?`
    );
    if (!ok) {
      setDataMessage("Import cancel kar diya.");
      return;
    }

    setDataMessage("Import ho raha hai...");
    const outcome = await importEntries(result.valid);
    render();

    if (outcome.failed > 0) {
      setDataMessage(
        `${outcome.saved} entries import hui, ${outcome.failed} save nahi ho saki (${outcome.message || "connection error"}). Dobara import karo — jo ho chuki hain wo skip ho jayengi.`,
        "error"
      );
    } else {
      setDataMessage(
        `${outcome.saved} entries import ho gayin. ${result.duplicates} duplicate aur ${result.invalid} galat rows skip hui.` + problems,
        "ok"
      );
    }
  } catch (err) {
    setDataMessage("Import fail ho gaya: " + (err.message || "unknown error"), "error");
  } finally {
    importBtn.disabled = false;
    exportBtn.disabled = false;
  }
});


/* ============================================================
   PART 11: Initial state — app auth screen se shuru hota hai
   ============================================================ */

setMode("deposit");
showAuth();

/* ============================================================
   PART 12: PWA install + offline shell
   ============================================================ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((error) => {
      console.warn("Service worker registration failed:", error.message);
    });
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.classList.remove("hidden-view");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.disabled = true;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden-view");
  installBtn.disabled = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden-view");
});
