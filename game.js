// ─── Config ────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "YOUR_SUPABASE_URL";
const SUPABASE_ANON = "YOUR_SUPABASE_ANON_KEY";
const TMDB_KEY      = "YOUR_TMDB_API_KEY";
const TMDB_IMG      = "https://image.tmdb.org/t/p/w342";
const MAX_GUESSES   = 5;

// ─── State ─────────────────────────────────────────────────────────────────
let puzzle       = null;   // { answer_tmdb_id, answer_title, answer_poster, clues[] }
let cluesShown   = 1;      // how many clue cards are visible
let guessCount   = 0;
let selectedMovie = null;  // { id, title, year, poster }
let gameOver     = false;
let searchTimer  = null;

// ─── DOM refs ──────────────────────────────────────────────────────────────
const clueGrid      = document.getElementById("clue-grid");
const searchInput   = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const guessBtn      = document.getElementById("guess-btn");
const guessHistory  = document.getElementById("guess-history");
const endScreen     = document.getElementById("end-screen");

// ─── Init ───────────────────────────────────────────────────────────────────
(async () => {
  const today = localDateString();
  const saved = loadState(today);

  puzzle = await fetchPuzzle(today);

  if (!puzzle) {
    showNoPuzzle();
    return;
  }

  if (saved) {
    restoreState(saved);
  } else {
    renderClues();
  }

  setupSearch();
})();

// ─── Supabase fetch ─────────────────────────────────────────────────────────
async function fetchPuzzle(date) {
  const url = `${SUPABASE_URL}/rest/v1/daily_puzzles?puzzle_date=eq.${date}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
    },
  });
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  return rows[0];
}

// ─── Render clues ───────────────────────────────────────────────────────────
function renderClues() {
  clueGrid.innerHTML = "";

  for (let i = 0; i < MAX_GUESSES; i++) {
    const clue = puzzle.clues[i];
    const card = document.createElement("div");
    card.className = "clue-card";
    card.dataset.index = i;

    if (i < cluesShown) {
      // Revealed clue
      const label = document.createElement("span");
      label.className = "clue-label";
      label.textContent = clue.category;

      const img = document.createElement("img");
      img.className = "clue-poster";
      img.src = clue.poster_url || "";
      img.alt = clue.hint_title;
      img.loading = "lazy";

      const title = document.createElement("p");
      title.className = "clue-hint-title";
      title.textContent = clue.hint_title;

      card.appendChild(label);
      card.appendChild(img);
      card.appendChild(title);
    } else {
      // Locked clue placeholder
      const placeholder = document.createElement("div");
      placeholder.className = "clue-poster-placeholder";
      placeholder.textContent = "?";

      const label = document.createElement("span");
      label.className = "clue-label";
      label.style.opacity = "0.3";
      label.textContent = clue.category;

      card.appendChild(label);
      card.appendChild(placeholder);
    }

    clueGrid.appendChild(card);
  }
}

// ─── Search ─────────────────────────────────────────────────────────────────
function setupSearch() {
  searchInput.addEventListener("input", () => {
    selectedMovie = null;
    guessBtn.disabled = true;
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      closeDropdown();
      return;
    }
    searchTimer = setTimeout(() => searchTMDB(q), 300);
  });

  searchInput.addEventListener("keydown", (e) => {
    const items = searchResults.querySelectorAll("li");
    const active = searchResults.querySelector("li.active");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (next) { active?.classList.remove("active"); next.classList.add("active"); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : items[items.length - 1];
      if (prev) { active?.classList.remove("active"); prev.classList.add("active"); }
    } else if (e.key === "Enter") {
      if (active) active.click();
      else if (selectedMovie) submitGuess();
    } else if (e.key === "Escape") {
      closeDropdown();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrapper")) closeDropdown();
  });

  guessBtn.addEventListener("click", submitGuess);
}

async function searchTMDB(query) {
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&include_adult=false`;
  const res  = await fetch(url);
  const data = await res.json();
  renderDropdown(data.results || []);
}

function renderDropdown(results) {
  searchResults.innerHTML = "";
  const top = results.slice(0, 8);
  if (!top.length) { closeDropdown(); return; }

  top.forEach((movie) => {
    const li   = document.createElement("li");
    const img  = document.createElement("img");
    img.src    = movie.poster_path ? TMDB_IMG + movie.poster_path : "";
    img.alt    = "";

    const name = document.createElement("span");
    name.textContent = movie.title;

    const year = document.createElement("span");
    year.className = "result-year";
    year.textContent = (movie.release_date || "").slice(0, 4);

    li.appendChild(img);
    li.appendChild(name);
    li.appendChild(year);

    li.addEventListener("click", () => {
      selectedMovie = {
        id:     movie.id,
        title:  movie.title,
        year:   (movie.release_date || "").slice(0, 4),
        poster: movie.poster_path ? TMDB_IMG + movie.poster_path : "",
      };
      searchInput.value = movie.title;
      guessBtn.disabled = false;
      closeDropdown();
    });

    searchResults.appendChild(li);
  });

  searchResults.classList.add("open");
}

function closeDropdown() {
  searchResults.classList.remove("open");
  searchResults.innerHTML = "";
}

// ─── Submit guess ────────────────────────────────────────────────────────────
function submitGuess() {
  if (!selectedMovie || gameOver) return;

  guessCount++;
  const isCorrect = selectedMovie.id === puzzle.answer_tmdb_id;

  addGuessRow(selectedMovie.title, isCorrect);

  if (isCorrect) {
    endGame(true);
  } else if (guessCount >= MAX_GUESSES) {
    endGame(false);
  } else {
    cluesShown = guessCount + 1;
    renderClues();
  }

  searchInput.value = "";
  selectedMovie = null;
  guessBtn.disabled = true;

  saveState();
}

function addGuessRow(title, correct) {
  const row = document.createElement("div");
  row.className = `guess-row ${correct ? "correct" : "wrong"}`;

  const icon = document.createElement("span");
  icon.className = "guess-icon";
  icon.textContent = correct ? "✅" : "❌";

  const name = document.createElement("span");
  name.className = "guess-name";
  name.textContent = title;

  row.appendChild(icon);
  row.appendChild(name);
  guessHistory.appendChild(row);
}

// ─── End game ────────────────────────────────────────────────────────────────
function endGame(won) {
  gameOver = true;

  document.getElementById("end-emoji").textContent   = won ? "🎉" : "💀";
  document.getElementById("end-title").textContent   = won ? "Nice one!" : "Better luck tomorrow!";
  document.getElementById("end-message").textContent = won
    ? `You got it in ${guessCount} clue${guessCount === 1 ? "" : "s"}!`
    : "The movie was…";
  document.getElementById("end-poster").src          = puzzle.answer_poster || "";
  document.getElementById("end-movie-title").textContent = puzzle.answer_title;

  endScreen.classList.remove("hidden");

  document.getElementById("share-btn").addEventListener("click", shareResult.bind(null, won));

  // Disable input
  searchInput.disabled = true;
  guessBtn.disabled    = true;

  saveState();
}

// ─── Share ────────────────────────────────────────────────────────────────────
function shareResult(won) {
  const squares = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (i < guessCount - (won ? 1 : 0)) squares.push("🟥");
    else if (won && i === guessCount - 1)  squares.push("🟩");
    else squares.push("⬛");
  }
  const text = `🎬 CineClue ${localDateString()}\n${squares.join("")}\nhttps://YOUR_GAME_URL`;
  navigator.clipboard.writeText(text).then(() => {
    document.getElementById("share-btn").textContent = "Copied!";
    setTimeout(() => { document.getElementById("share-btn").textContent = "Share Result"; }, 2000);
  });
}

// ─── Persist state ────────────────────────────────────────────────────────────
function saveState() {
  const state = { guessCount, cluesShown, gameOver, guesses: [] };
  guessHistory.querySelectorAll(".guess-row").forEach((r) => {
    state.guesses.push({ title: r.querySelector(".guess-name").textContent, correct: r.classList.contains("correct") });
  });
  localStorage.setItem(`cineclue_${localDateString()}`, JSON.stringify(state));
}

function loadState(date) {
  const raw = localStorage.getItem(`cineclue_${date}`);
  return raw ? JSON.parse(raw) : null;
}

function restoreState(saved) {
  guessCount = saved.guessCount;
  cluesShown = saved.cluesShown;
  gameOver   = saved.gameOver;

  renderClues();

  saved.guesses.forEach((g) => addGuessRow(g.title, g.correct));

  if (gameOver) {
    const won = saved.guesses.at(-1)?.correct ?? false;
    endGame(won);
  } else {
    setupSearch();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function localDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function showNoPuzzle() {
  clueGrid.innerHTML = `
    <div id="no-puzzle">
      <h2>No puzzle today 🎬</h2>
      <p>Check back tomorrow!</p>
    </div>`;
  document.getElementById("guess-section").style.display = "none";
}
