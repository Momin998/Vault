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
  // Agar purani history di gayi hai (database se load hui), to balance
  // us history ki AAKHRI entry se le lo — warna fresh startingBalance use karo
  let balance = initialHistory.length
    ? initialHistory[initialHistory.length - 1].balance
    : startingBalance;
  let history = [...initialHistory];

  return {
    deposit(title, amount) {
      balance += amount;
      history.push({ type: "deposit", title, amount, balance });
      return balance;
    },
    withdraw(title, amount) {
      if (amount > balance) {
        return null; // insufficient balance — closure khud validate karta hai
      }
      balance -= amount;
      history.push({ type: "withdraw", title, amount, balance });
      return balance;
    },
    getBalance() {
      return balance;
    },
    getHistory() {
      return [...history]; // hamesha ek copy — asal history protected rehti hai
    }
  };
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

if (SUPABASE_URL !== 'https://YOUR_PROJECT_REF.supabase.co') {
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
const userPhoneDisplay = document.getElementById("userPhoneDisplay");

const balanceFigure = document.getElementById("balanceFigure");
const totalInEl      = document.getElementById("totalIn");
const totalOutEl     = document.getElementById("totalOut");

const btnDeposit  = document.getElementById("btnDeposit");
const btnWithdraw = document.getElementById("btnWithdraw");
const entryForm    = document.getElementById("entryForm");
const titleInput   = document.getElementById("title");
const amountInput  = document.getElementById("amount");
const submitBtn    = document.getElementById("submitBtn");
const submitLabel  = submitBtn.querySelector(".submit-label");
const formError    = document.getElementById("formError");

const ledgerList  = document.getElementById("ledgerList");
const ledgerCount = document.getElementById("ledgerCount");
const emptyState  = document.getElementById("emptyState");

let isLoginMode = true;
let currentUser = null;
let currentMode = "deposit";


/* ============================================================
   PART 4b: Database se purani history load karna
   ============================================================ */

async function loadTransactionsFromDatabase(userId) {
  const { data, error } = await supabaseClient
    .from("transactions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true }); // purane se naye order mein

  if (error) {
    console.error("History load nahi ho saki:", error.message);
    return []; // khaali history — user ko kam se kam app to milega
  }

  // Database ke rows ko wahi shape dete hain jo createWallet expect karta hai
  return data.map((row) => ({
    type: row.type,
    title: row.title,
    amount: Number(row.amount),
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
    } else {
      // Supabase abhi connect nahi hai (URL/Key nahi dali) — local-only mode
      currentUser = { phone };
      myWallet = createWallet(0);
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
  showAuth();
});


/* ============================================================
   PART 7: Helpers
   ============================================================ */

function formatMoney(n) {
  return "Rs " + n.toLocaleString("en-PK");
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

  ledgerList.innerHTML = "";
  const reversed = [...history].reverse();

  reversed.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "ledger-item";

    const index = history.length - i;
    const sign = entry.type === "deposit" ? "+" : "−";
    const icon = entry.type === "deposit" ? "↑" : "↓";

    li.innerHTML = `
      <span class="item-index">#${index}</span>
      <span class="item-icon ${entry.type}">${icon}</span>
      <span class="item-body">
        <span class="item-title">${escapeHtml(entry.title)}</span>
        <span class="item-meta">Balance after: ${formatMoney(entry.balance)}</span>
      </span>
      <span class="item-amount ${entry.type}">${sign} ${formatMoney(entry.amount)}</span>
    `;
    ledgerList.appendChild(li);
  });

  ledgerCount.textContent = `${history.length} ${history.length === 1 ? "entry" : "entries"}`;
  emptyState.classList.toggle("show", history.length === 0);
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
  formError.textContent = "";
}

btnDeposit.addEventListener("click", () => setMode("deposit"));
btnWithdraw.addEventListener("click", () => setMode("withdraw"));


/* ============================================================
   PART 10: Deposit/Withdraw form submit
   ============================================================ */

entryForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = titleInput.value.trim();
  const amount = Number(amountInput.value);

  if (!title || !amount || amount <= 0) {
    formError.textContent = "Enter a valid title and amount.";
    return;
  }

  submitBtn.disabled = true;
  submitLabel.textContent = "Saving...";

  try {
    if (currentMode === "deposit") {
      myWallet.deposit(title, amount);
    } else {
      const result = myWallet.withdraw(title, amount);
      if (result === null) {
        formError.textContent = "Insufficient balance for this withdrawal.";
        return;
      }
    }

    if (isConnected) {
      // Wallet ne jo aakhri entry banayi (upar), usi ka poora record
      // database mein bhi save kar rahe hain
      const history = myWallet.getHistory();
      const lastEntry = history[history.length - 1];

      const { error } = await supabaseClient.from("transactions").insert([
        {
          user_id: currentUser.id,
          type: lastEntry.type,
          title: lastEntry.title,
          amount: lastEntry.amount,
          balance: lastEntry.balance
        }
      ]);

      if (error) {
        // Local balance already update ho chuka hai — user ko bata do
        // ke save fail hua, taake wo dobara try kare ya connection check kare
        formError.textContent = "Saved locally, but failed to sync: " + error.message;
        titleInput.value = "";
        amountInput.value = "";
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
   PART 11: Initial state — app auth screen se shuru hota hai
   ============================================================ */

setMode("deposit");
showAuth();
