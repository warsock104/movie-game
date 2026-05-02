// ─── Config ─────────────────────────────────────────────────────────────────
const TMDB_KEY        = "74aa14a014f685118e47f13cfaaabf07";
const SUPABASE_URL    = "https://vocsfxosmbpcjvadwddf.supabase.co";
const SUPABASE_ANON   = "sb_publishable_gxIgyHUktN-BuChGRy_5YA_6WdeCMiU";
const TMDB_IMG        = "https://image.tmdb.org/t/p/w342";
const TMDB_PROFILE    = "https://image.tmdb.org/t/p/w185";
const MAX_ROUNDS      = 5;
const MOVIE_MIN_VOTES = 5000;
const ODD_MIN_VOTES   = 5000;
const ACTOR_POOL_PAGES = 8;
const STATS_KEY       = 'ooo_stats';
const STREAK_KEY      = 'ooo_streak';
const SEEN_ACTORS_KEY = 'ooo_seen_actors';
const STATE_PREFIX    = 'ooo_daily_';
const MAX_SEEN_ACTORS = 50;
const POOL_CACHE_KEY  = 'ooo_actor_pool';

// ─── State ───────────────────────────────────────────────────────────────────
let round             = 0;
let roundResults      = [];
let usedActorIds      = new Set();
let invalidActorIds   = new Set();
let actorPool         = [];
let currentActor      = null;
let currentOddOneOut  = null;
let inputLocked       = false;
let nextRoundPromise  = null;
let savedRounds       = null;
let isPractice        = false;
let noPuzzleToday     = false;
let retryCount        = 0;
let todayDate         = '';
let countdownInterval = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const loadingEl  = document.getElementById('loading');
const gameUi     = document.getElementById('game-ui');
const endScreen  = document.getElementById('end-screen');
const actorPhoto = document.getElementById('actor-photo');
const actorName  = document.getElementById('actor-name');
const posterGrid = document.getElementById('poster-grid');
const pips       = document.querySelectorAll('.round-pip');

// ─── Boot ────────────────────────────────────────────────────────────────────
(async () => {
  todayDate = localDateString();
  const dateParam  = new URLSearchParams(window.location.search).get('date');
  const targetDate = dateParam || todayDate;

  const puzzle = await fetchSavedPuzzle(targetDate);
  if (puzzle) {
    savedRounds = puzzle;
    isPractice  = !!dateParam; // URL param = builder test, not tracked as daily
  } else {
    isPractice    = true;
    noPuzzleToday = !dateParam; // only flag it when not a builder test
    actorPool     = await fetchPopularActors();
  }

  if (!isPractice) {
    const saved = loadState(todayDate);
    if (saved) { restoreState(saved); return; }
  }

  updatePracticeBanner();
  renderStreak();
  await startNextRound();
})();

// ─── Saved puzzle ────────────────────────────────────────────────────────────
async function fetchSavedPuzzle(date) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ooo_puzzles?puzzle_date=eq.${date}&select=rounds`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
    );
    const data = await res.json();
    if (data.length && data[0].rounds?.length) return data[0].rounds;
  } catch {}
  return null;
}

function buildSavedRoundData(r) {
  return {
    actor:      r.actor,
    allPosters: shuffle([...r.connected, r.odd_one_out]),
    oddOneOut:  r.odd_one_out,
  };
}

// ─── Actor pool ──────────────────────────────────────────────────────────────
async function fetchPopularActors() {
  try {
    const cached = sessionStorage.getItem(POOL_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch {}

  const pages = await Promise.all(
    Array.from({ length: ACTOR_POOL_PAGES }, (_, i) =>
      tmdb(`/person/popular?page=${i + 1}`).catch(() => ({ results: [] }))
    )
  );
  const candidates = [];
  pages.forEach(data => candidates.push(...(data.results || []).filter(p =>
    p.known_for_department === 'Acting' &&
    p.profile_path &&
    Math.max(0, ...(p.known_for || []).map(m => m.vote_count || 0)) >= 3000
  )));
  const maxVotes = a => Math.max(0, ...(a.known_for || []).map(m => m.vote_count || 0));
  const pool = candidates.sort((a, b) => maxVotes(b) - maxVotes(a));
  try { sessionStorage.setItem(POOL_CACHE_KEY, JSON.stringify(pool)); } catch {}
  return pool;
}

// Split pool into MAX_ROUNDS tiers; round 1 = most popular tier
function pickActorForRound(forRound = round) {
  const seen  = loadSeenActors();
  const avail = a => !usedActorIds.has(a.id) && !invalidActorIds.has(a.id);
  const fresh = a => avail(a) && !seen.has(a.id);

  const tierSize  = Math.ceil(actorPool.length / MAX_ROUNDS);
  const tierStart = (forRound - 1) * tierSize;
  const tierEnd   = Math.min(tierStart + tierSize, actorPool.length);
  const tierSlice = actorPool.slice(tierStart, tierEnd);

  const tierFresh = tierSlice.filter(fresh);
  if (tierFresh.length) return tierFresh[Math.floor(Math.random() * tierFresh.length)];

  const tierAvail = tierSlice.filter(avail);
  if (tierAvail.length) return tierAvail[Math.floor(Math.random() * tierAvail.length)];

  const anyFresh = actorPool.filter(fresh);
  if (anyFresh.length) return anyFresh[Math.floor(Math.random() * anyFresh.length)];

  const anyAvail = actorPool.filter(avail);
  return anyAvail.length ? anyAvail[Math.floor(Math.random() * anyAvail.length)] : null;
}

// ─── Round orchestration ─────────────────────────────────────────────────────
async function startNextRound() {
  if (round >= MAX_ROUNDS) { showVictory(); return; }

  round++;
  markPipActive(round);

  setLoading(true);
  let roundData;
  if (savedRounds) {
    roundData = buildSavedRoundData(savedRounds[round - 1]);
  } else {
    const promise = nextRoundPromise ?? generateRoundData(0, round);
    nextRoundPromise = null;
    roundData = await promise;
    if (!roundData) roundData = await generateRoundData(0, round);
  }
  if (!roundData) {
    const msg = retryCount >= 2
      ? "Still having trouble — please refresh the page."
      : "Couldn't generate a round — try again.";
    showError(msg);
    return;
  }

  currentActor     = roundData.actor;
  currentOddOneOut = roundData.oddOneOut;

  setLoading(false);
  renderRound(roundData.actor, roundData.allPosters, roundData.oddOneOut);
}

async function generateRoundData(attempts = 0, forRound = round) {
  if (attempts >= 40) return null;

  const actor = pickActorForRound(forRound);
  if (!actor) return null;

  const { list: actorMovies, idSet: actorIdSet } = await getActorMovies(actor.id);
  if (actorMovies.length < 3) {
    invalidActorIds.add(actor.id);
    return generateRoundData(attempts + 1, forRound);
  }

  usedActorIds.add(actor.id);
  markActorSeen(actor.id);

  const connectedMovies = pickN(actorMovies, 3);
  const oddOneOut = await findOddOneOut(actorIdSet);
  if (!oddOneOut) return generateRoundData(attempts + 1, forRound);

  return {
    actor,
    allPosters: shuffle([...connectedMovies, oddOneOut]),
    oddOneOut,
  };
}

async function getActorMovies(actorId) {
  const data = await tmdb(`/person/${actorId}/movie_credits`);

  const hasLeadRole = data.cast.some(m => m.order <= 2 && m.vote_count >= ODD_MIN_VOTES);
  if (!hasLeadRole) return { list: [], idSet: new Set() };

  const list = data.cast
    .filter(m => m.poster_path && m.vote_count >= MOVIE_MIN_VOTES && m.order <= 10)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 25);
  const idSet = new Set(data.cast.map(m => m.id));
  return { list, idSet };
}

async function findOddOneOut(actorIdSet) {
  const startPage = Math.floor(Math.random() * 250) + 1;
  for (let offset = 0; offset < 5; offset++) {
    const page = startPage + offset;
    const data = await tmdb(
      `/discover/movie?sort_by=vote_count.desc&vote_count.gte=${ODD_MIN_VOTES}&page=${page}`
    );
    const candidates = data.results.filter(m => m.poster_path && !actorIdSet.has(m.id));
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}

// ─── Render ──────────────────────────────────────────────────────────────────
function renderRound(actor, posters, oddOneOut) {
  if (actor.profile_path) {
    actorPhoto.src = `${TMDB_PROFILE}${actor.profile_path}`;
    actorPhoto.style.display = 'block';
  } else {
    actorPhoto.style.display = 'none';
  }
  actorName.textContent = actor.name;

  posterGrid.innerHTML = '';
  posters.forEach(movie => {
    const card = document.createElement('div');
    card.className = 'poster-card';
    card.dataset.movieId = movie.id;
    card.innerHTML = `
      <img src="${TMDB_IMG}${movie.poster_path}" alt="${movie.title}" draggable="false">
      <p class="movie-label">${movie.title}</p>
    `;
    card.addEventListener('click', () => handleClick(movie, card));
    posterGrid.appendChild(card);
  });

  gameUi.classList.remove('hidden');
  inputLocked = false;

  if (round < MAX_ROUNDS && !savedRounds) {
    nextRoundPromise = generateRoundData(0, round + 1);
  }
}

// ─── Interaction ─────────────────────────────────────────────────────────────
async function handleClick(movie, clickedCard) {
  if (inputLocked) return;
  inputLocked = true;

  const isCorrect  = movie.id === currentOddOneOut.id;
  const currentPip = pips[round - 1];

  if (isCorrect) {
    roundResults.push(true);
    clickedCard.classList.add('correct');
    currentPip.classList.remove('active');
    currentPip.classList.add('done');
    saveState();
    await delay(900);
    await startNextRound();
  } else {
    roundResults.push(false);
    clickedCard.classList.add('wrong');
    document.querySelectorAll('.poster-card').forEach(c => {
      if (parseInt(c.dataset.movieId) === currentOddOneOut.id) c.classList.add('reveal');
    });
    currentPip.classList.remove('active');
    currentPip.classList.add('failed');
    saveState(false, round - 1);
    await delay(1800);
    showGameOver(round - 1);
  }
}

// ─── End screens ─────────────────────────────────────────────────────────────
function showGameOver(survived) {
  gameUi.classList.add('hidden');
  renderEndScreen(survived);
}

function showVictory() {
  gameUi.classList.add('hidden');
  saveState(true, MAX_ROUNDS);
  renderEndScreen(MAX_ROUNDS);
}

function renderEndScreen(survived) {
  const won   = survived === MAX_ROUNDS;
  const stats = recordResult(survived);

  document.getElementById('end-emoji').textContent =
    won ? '🏆' : survived === 0 ? '💀' : survived < 3 ? '😬' : '😮';
  document.getElementById('end-title').textContent =
    won ? 'Perfect Run!' : survived === 0 ? 'Out on Round 1' : `${survived} Round${survived !== 1 ? 's' : ''} Survived`;
  document.getElementById('end-message').textContent =
    won ? "You're a certified movie buff." : survived === 0 ? 'Better luck next time!' : 'So close!';

  // Streak
  updateStreak(won);
  const { current, best } = loadStreak();
  const streakEl = document.getElementById('end-streak');
  if (!isPractice && won && current > 0) {
    streakEl.textContent = current === 1
      ? '🔥 Win streak started!'
      : `🔥 ${current} streak${current === best ? ' — new best!' : ''}`;
    streakEl.style.display = '';
  } else {
    streakEl.style.display = 'none';
  }

  // Result pips
  document.getElementById('result-grid').innerHTML = Array.from({ length: MAX_ROUNDS }, (_, i) => {
    const cls = i < roundResults.length ? (roundResults[i] ? 'correct' : 'wrong') : '';
    return `<div class="result-pip ${cls}"></div>`;
  }).join('');

  // Reveal on loss
  const revealBox = document.getElementById('reveal-box');
  if (!won && currentActor && currentOddOneOut) {
    revealBox.innerHTML = `
      <p class="rlabel">Actor</p>
      <p class="rvalue">${currentActor.name}</p>
      <p class="rlabel" style="margin-top:8px">Odd one out</p>
      <p class="rvalue">${currentOddOneOut.title}</p>
    `;
    revealBox.style.display = 'block';
  } else {
    revealBox.style.display = 'none';
  }

  // Stats
  const winPct = stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
  document.getElementById('end-stats-grid').innerHTML = `
    <div class="end-stat"><span class="end-stat-num">${stats.played}</span><span class="end-stat-label">Played</span></div>
    <div class="end-stat"><span class="end-stat-num">${winPct}%</span><span class="end-stat-label">Perfect</span></div>
    <div class="end-stat"><span class="end-stat-num">${current}</span><span class="end-stat-label">Streak</span></div>
    <div class="end-stat"><span class="end-stat-num">${stats.bestScore}</span><span class="end-stat-label">Best</span></div>
  `;

  // Buttons / countdown
  const shareBtn       = document.getElementById('share-btn');
  const newPracticeBtn = document.getElementById('new-practice-btn');
  const nextPuzzleEl   = document.getElementById('next-puzzle');

  shareBtn.style.display       = isPractice ? 'none' : 'block';
  newPracticeBtn.style.display = 'block';
  nextPuzzleEl.style.display   = isPractice ? 'none' : 'flex';

  shareBtn.onclick       = () => shareResult(won, survived);
  newPracticeBtn.onclick = startPractice;

  if (!isPractice) startCountdown();

  document.getElementById('end-close-btn').onclick = () => {
    endScreen.classList.add('hidden');
    if (posterGrid.children.length > 0) gameUi.classList.remove('hidden');
  };

  endScreen.classList.remove('hidden');
}

function showError(msg) {
  setLoading(false);
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-wrap').style.display = 'block';
}

document.getElementById('retry-btn').addEventListener('click', retryRound);

function retryRound() {
  document.getElementById('error-wrap').style.display = 'none';
  retryCount++;
  pips[round - 1].classList.remove('active');
  round--;
  startNextRound();
}

// ─── Stats modal ─────────────────────────────────────────────────────────────
document.getElementById('stats-btn').addEventListener('click', openOooStats);
document.getElementById('stats-close-btn').addEventListener('click', () => {
  document.getElementById('stats-modal').classList.add('hidden');
});

function openOooStats() {
  const stats  = loadStats();
  const streak = loadStreak();
  const winPct = stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
  document.getElementById('stat-played').textContent  = stats.played;
  document.getElementById('stat-win-pct').textContent = winPct;
  document.getElementById('stat-streak').textContent  = streak.current;
  document.getElementById('stat-best').textContent    = stats.bestScore;
  document.getElementById('stats-modal').classList.remove('hidden');
}

// ─── How to play ──────────────────────────────────────────────────────────────
document.getElementById('how-to-play-btn').addEventListener('click', showOooTutorial);

function showOooTutorial() {
  const overlay = document.getElementById('tutorial-overlay');
  overlay.classList.remove('hidden');
  function dismiss() { overlay.classList.add('hidden'); }
  document.getElementById('tutorial-got-it').onclick = dismiss;
  overlay.onclick = e => { if (e.target === overlay) dismiss(); };
}

// ─── Practice mode ────────────────────────────────────────────────────────────
document.getElementById('practice-btn').addEventListener('click', startPractice);

async function startPractice() {
  if (!inputLocked && round > 0 && roundResults.length < MAX_ROUNDS) {
    if (!confirm('Start a new practice game?')) return;
  }

  const btn = document.getElementById('practice-btn');
  btn.textContent = 'Loading…';
  btn.disabled    = true;

  // Reset all state
  round            = 0;
  roundResults     = [];
  usedActorIds     = new Set();
  invalidActorIds  = new Set();
  currentActor     = null;
  currentOddOneOut = null;
  inputLocked      = false;
  nextRoundPromise = null;
  savedRounds      = null;
  isPractice       = true;
  noPuzzleToday    = false;
  retryCount       = 0;
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  pips.forEach(p => { p.className = 'round-pip'; });
  gameUi.classList.add('hidden');
  endScreen.classList.add('hidden');
  document.getElementById('error-msg').style.display = 'none';

  updatePracticeBanner();
  renderStreak();

  try {
    actorPool = await fetchPopularActors();
    await startNextRound();
  } finally {
    btn.textContent = 'Practice';
    btn.disabled    = false;
  }
}

// ─── Share ───────────────────────────────────────────────────────────────────
function shareResult(won, survived) {
  const emojis = Array.from({ length: MAX_ROUNDS }, (_, i) =>
    i < roundResults.length ? (roundResults[i] ? '🟩' : '🟥') : '⬜'
  );
  const text = [
    `Odd One Out 🎬 ${survived}/${MAX_ROUNDS}`,
    emojis.join(''),
    'https://moviehunch.com',
  ].join('\n');

  const btn     = document.getElementById('share-btn');
  const confirm = () => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Share'; }, 2000);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(confirm);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    confirm();
  }
}

// ─── Countdown ───────────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const el = document.getElementById('next-puzzle-countdown');
  if (!el) return;
  function tick() {
    const now      = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    const diff = midnight - now;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

// ─── State persistence ───────────────────────────────────────────────────────
function saveState(won = null, survived = null) {
  if (isPractice) return;
  const posters = Array.from(posterGrid.querySelectorAll('.poster-card')).map(card => ({
    movieId:     parseInt(card.dataset.movieId),
    title:       card.querySelector('.movie-label')?.textContent ?? '',
    posterSrc:   card.querySelector('img')?.src ?? '',
    isCorrect:   card.classList.contains('correct'),
    isWrong:     card.classList.contains('wrong'),
    isReveal:    card.classList.contains('reveal'),
  }));
  const state = {
    roundResults,
    round,
    gameOver:        won !== null,
    won,
    survived,
    actorName:       currentActor?.name         ?? '',
    actorProfilePath: currentActor?.profile_path ?? '',
    oddTitle:        currentOddOneOut?.title     ?? '',
    lastPosters:     posters,
  };
  localStorage.setItem(`${STATE_PREFIX}${todayDate}`, JSON.stringify(state));
}

function loadState(date) {
  try {
    const raw = localStorage.getItem(`${STATE_PREFIX}${date}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function restoreState(saved) {
  roundResults = saved.roundResults || [];
  round        = saved.round || roundResults.length;
  isPractice   = false;

  roundResults.forEach((correct, i) => {
    pips[i].classList.remove('active');
    pips[i].classList.add(correct ? 'done' : 'failed');
  });

  updatePracticeBanner();
  renderStreak();

  if (saved.gameOver) {
    setLoading(false);
    currentActor     = { name: saved.actorName || '—', profile_path: saved.actorProfilePath || null };
    currentOddOneOut = { title: saved.oddTitle  || '—' };
    if (saved.lastPosters?.length) restoreLastRound(saved);
    renderEndScreen(saved.survived ?? roundResults.filter(Boolean).length);
  } else if (savedRounds) {
    startNextRound();
  } else {
    fetchPopularActors().then(pool => { actorPool = pool; startNextRound(); });
  }
}

function restoreLastRound(saved) {
  if (saved.actorProfilePath) {
    actorPhoto.src = `${TMDB_PROFILE}${saved.actorProfilePath}`;
    actorPhoto.style.display = 'block';
  } else {
    actorPhoto.style.display = 'none';
  }
  actorName.textContent = saved.actorName || '—';

  posterGrid.innerHTML = '';
  saved.lastPosters.forEach(p => {
    const card = document.createElement('div');
    card.className = 'poster-card';
    if (p.isCorrect) card.classList.add('correct');
    if (p.isWrong)   card.classList.add('wrong');
    if (p.isReveal)  card.classList.add('reveal');
    card.dataset.movieId = p.movieId;
    card.innerHTML = `
      <img src="${p.posterSrc}" alt="${p.title}" draggable="false">
      <p class="movie-label">${p.title}</p>
    `;
    posterGrid.appendChild(card);
  });

  inputLocked = true;
  gameUi.classList.remove('hidden');
}

// ─── Seen actors (cross-session dedup) ───────────────────────────────────────
function loadSeenActors() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_ACTORS_KEY)) || []); }
  catch { return new Set(); }
}

function markActorSeen(actorId) {
  let seen = JSON.parse(localStorage.getItem(SEEN_ACTORS_KEY) || '[]');
  seen = seen.filter(id => id !== actorId);
  seen.push(actorId);
  if (seen.length > MAX_SEEN_ACTORS) seen = seen.slice(-MAX_SEEN_ACTORS);
  localStorage.setItem(SEEN_ACTORS_KEY, JSON.stringify(seen));
}

// ─── Streak ──────────────────────────────────────────────────────────────────
function loadStreak() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY)) || { current: 0, best: 0, last_date: null }; }
  catch { return { current: 0, best: 0, last_date: null }; }
}

function updateStreak(won) {
  if (isPractice) return;
  const s = loadStreak();
  if (s.last_date === todayDate) return;
  if (won) {
    s.current++;
    if (s.current > s.best) s.best = s.current;
  } else {
    s.current = 0;
  }
  s.last_date = todayDate;
  localStorage.setItem(STREAK_KEY, JSON.stringify(s));
  renderStreak();
}

function renderStreak() {
  const el = document.getElementById('streak-display');
  if (!el) return;
  const { current, best } = loadStreak();
  if (!isPractice && current > 0) {
    el.textContent = `🔥 ${current}`;
    el.title       = `Best streak: ${best}`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || defaultStats(); }
  catch { return defaultStats(); }
}

function defaultStats() {
  return { played: 0, wins: 0, bestScore: 0, last_date: null };
}

function recordResult(survived) {
  if (isPractice) return loadStats();
  const s = loadStats();
  if (s.last_date === todayDate) return s;
  s.played++;
  if (survived === MAX_ROUNDS) s.wins++;
  s.bestScore  = Math.max(s.bestScore, survived);
  s.last_date  = todayDate;
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  return s;
}

// ─── Practice banner ─────────────────────────────────────────────────────────
function updatePracticeBanner() {
  document.getElementById('practice-banner').style.display = isPractice ? 'block' : 'none';
  const noteEl = document.getElementById('no-puzzle-note');
  if (noteEl) noteEl.style.display = noPuzzleToday ? 'block' : 'none';
}

// ─── Pip helpers ─────────────────────────────────────────────────────────────
function markPipActive(r) {
  if (r - 1 < pips.length) pips[r - 1].classList.add('active');
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function setLoading(show) {
  loadingEl.classList.toggle('hidden', !show);
  if (show) gameUi.classList.add('hidden');
}

function localDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pickN(arr, n) { return shuffle(arr).slice(0, n); }
function shuffle(arr)  { return [...arr].sort(() => Math.random() - 0.5); }
function delay(ms)     { return new Promise(r => setTimeout(r, ms)); }

async function tmdb(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${TMDB_KEY}`);
  return res.json();
}
