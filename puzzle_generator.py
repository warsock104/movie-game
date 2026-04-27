"""
Daily puzzle generator for CineClue.

Picks a popular movie, builds 5 clues (Director, Genre, Year, Actor, Actor),
and upserts the result into Supabase `daily_puzzles`.

Run manually:  python puzzle_generator.py
Runs via GitHub Actions: .github/workflows/daily_puzzle.yml
"""

import os, random, datetime, requests
from dotenv import load_dotenv

load_dotenv()

TMDB_KEY      = os.environ["TMDB_API_KEY"]
SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_SERVICE_KEY"]  # service role key for writes
TMDB_BASE     = "https://api.themoviedb.org/3"
TMDB_IMG      = "https://image.tmdb.org/t/p/w342"

# Popularity thresholds — keeps answers well-known
MIN_VOTE_COUNT  = 10000
MIN_POPULARITY  = 30
# Clue hint movies must still be recognisable
HINT_MIN_VOTES  = 1000

CLUE_ORDER = ["DIRECTOR", "GENRE", "YEAR", "ACTOR", "ACTOR"]

# ─── TMDB helpers ─────────────────────────────────────────────────────────────

def tmdb(path, **params):
    # TMDB discover uses dot notation for comparisons (e.g. vote_count.gte)
    for underscore, dot in [("vote_count_gte", "vote_count.gte"),
                             ("vote_average_gte", "vote_average.gte"),
                             ("popularity_gte", "popularity.gte")]:
        if underscore in params:
            params[dot] = params.pop(underscore)
    params["api_key"] = TMDB_KEY
    r = requests.get(f"{TMDB_BASE}{path}", params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def poster_url(path):
    return TMDB_IMG + path if path else None

def get_credits(movie_id):
    return tmdb(f"/movie/{movie_id}/credits")

def get_movie_details(movie_id):
    return tmdb(f"/movie/{movie_id}", append_to_response="credits")

# ─── Popular movie pool ────────────────────────────────────────────────────────

def fetch_popular_pool(pages=10):
    """Fetch a pool of popular movies suitable as answers."""
    movies = []
    for page in range(1, pages + 1):
        data = tmdb("/discover/movie",
                    sort_by="popularity.desc",
                    vote_count_gte=MIN_VOTE_COUNT,
                    popularity_gte=MIN_POPULARITY,
                    with_original_language="en",
                    page=page)
        movies.extend(data.get("results", []))
    return movies

# ─── Already-used answers ──────────────────────────────────────────────────────

def fetch_used_ids():
    """Return set of answer_tmdb_id already stored in Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/daily_puzzles?select=answer_tmdb_id"
    r = requests.get(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }, timeout=10)
    r.raise_for_status()
    return {row["answer_tmdb_id"] for row in r.json()}

# ─── Clue builders ─────────────────────────────────────────────────────────────

def find_director_clue(movie_id, answer_id, credits):
    directors = [c for c in credits.get("crew", []) if c["job"] == "Director"]
    if not directors:
        return None
    director = directors[0]
    data = tmdb("/discover/movie",
                with_crew=director["id"],
                sort_by="vote_count.desc",
                vote_count_gte=HINT_MIN_VOTES,
                with_original_language="en",
                page=1)
    candidates = [m for m in data.get("results", []) if m["id"] != answer_id]
    if not candidates:
        return None
    m = candidates[0]
    return {"category": "DIRECTOR", "connection": director["name"],
            "hint_tmdb_id": m["id"],
            "hint_title": m["title"], "poster_url": poster_url(m.get("poster_path"))}

def find_genre_clue(answer_id, genres):
    if not genres:
        return None
    genre_id = genres[0]["id"]
    data = tmdb("/discover/movie",
                with_genres=genre_id,
                sort_by="vote_count.desc",
                vote_count_gte=HINT_MIN_VOTES,
                with_original_language="en",
                page=1)
    candidates = [m for m in data.get("results", []) if m["id"] != answer_id]
    if not candidates:
        return None
    # Pick randomly from top 20 so clues vary day-to-day
    m = random.choice(candidates[:20])
    return {"category": "GENRE", "connection": genres[0]["name"],
            "hint_tmdb_id": m["id"],
            "hint_title": m["title"], "poster_url": poster_url(m.get("poster_path"))}

def find_year_clue(answer_id, release_date):
    if not release_date:
        return None
    year = release_date[:4]
    data = tmdb("/discover/movie",
                primary_release_year=year,
                sort_by="vote_count.desc",
                vote_count_gte=HINT_MIN_VOTES,
                with_original_language="en",
                page=1)
    candidates = [m for m in data.get("results", []) if m["id"] != answer_id]
    if not candidates:
        return None
    m = random.choice(candidates[:10])
    return {"category": "YEAR", "connection": year,
            "hint_tmdb_id": m["id"],
            "hint_title": m["title"], "poster_url": poster_url(m.get("poster_path"))}

def find_actor_clue(answer_id, credits, exclude_ids, lead_only=False):
    cast = [c for c in credits.get("cast", []) if c["id"] not in exclude_ids]
    cast.sort(key=lambda c: c.get("order", 99))
    # lead_only=True: only try the top-billed actor (first ACTOR clue)
    # lead_only=False: try actors 2-6 (second ACTOR clue)
    pool = cast[:1] if lead_only else cast[1:6]
    for actor in pool:
        data = tmdb("/discover/movie",
                    with_cast=actor["id"],
                    sort_by="vote_count.desc",
                    vote_count_gte=HINT_MIN_VOTES,
                    with_original_language="en",
                    page=1)
        candidates = [m for m in data.get("results", []) if m["id"] != answer_id]
        if candidates:
            m = random.choice(candidates[:8])
            exclude_ids.add(actor["id"])
            return {"category": "ACTOR", "connection": actor["name"],
                    "hint_tmdb_id": m["id"],
                    "hint_title": m["title"], "poster_url": poster_url(m.get("poster_path"))}
    return None

# ─── Build full puzzle ─────────────────────────────────────────────────────────

def build_puzzle(movie, used_hint_ids=None, force=False):
    """Build a 5-clue puzzle for `movie`. Returns None if clues can't be filled."""
    if used_hint_ids is None:
        used_hint_ids = set()

    details = get_movie_details(movie["id"])

    # Skip sequels / franchise entries (bypass with force=True for manual additions)
    if not force and details.get("belongs_to_collection"):
        return None

    credits = details.get("credits", {})
    genres  = details.get("genres", [])

    used_actor_ids = set()
    clues = []

    builders = [
        lambda: find_director_clue(movie["id"], movie["id"], credits),
        lambda: find_genre_clue(movie["id"], genres),
        lambda: find_year_clue(movie["id"], movie.get("release_date")),
        lambda: find_actor_clue(movie["id"], credits, used_actor_ids, lead_only=True),
        lambda: find_actor_clue(movie["id"], credits, used_actor_ids),
    ]

    for build in builders:
        clue = build()
        if clue is None:
            return None
        # Avoid reusing the same hint movie across clues
        if clue["hint_tmdb_id"] in used_hint_ids:
            return None
        used_hint_ids.add(clue["hint_tmdb_id"])
        clues.append(clue)

    return {
        "answer_tmdb_id":  movie["id"],
        "answer_title":    movie["title"],
        "answer_poster":   poster_url(movie.get("poster_path")),
        "clues":           clues,
    }

# ─── Supabase upsert ───────────────────────────────────────────────────────────

def upsert_puzzle(date_str, puzzle_data):
    payload = {"puzzle_date": date_str, **puzzle_data}
    # clues is already a list — pass as-is so requests serialises it as a JSON array

    url = f"{SUPABASE_URL}/rest/v1/daily_puzzles?on_conflict=puzzle_date"
    r = requests.post(url, json=payload, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }, timeout=10)
    r.raise_for_status()
    print(f"[OK] Puzzle for {date_str} saved: {puzzle_data['answer_title']}")

# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    target_date = datetime.date.today() + datetime.timedelta(days=1)
    date_str    = target_date.isoformat()

    print(f"Generating puzzle for {date_str}…")

    used_ids = fetch_used_ids()
    pool     = fetch_popular_pool(pages=15)
    random.shuffle(pool)

    current_year = str(datetime.date.today().year)
    for movie in pool:
        if movie["id"] in used_ids:
            continue
        if (movie.get("release_date") or "")[:4] == current_year:
            continue
        print(f"  Trying: {movie['title']} ({movie.get('release_date','')[:4]})")
        try:
            puzzle = build_puzzle(movie)
        except Exception as e:
            print(f"    [skip] ({e})")
            continue
        if puzzle:
            upsert_puzzle(date_str, puzzle)
            return

    print("[FAIL] Could not find a suitable movie. Try expanding the pool.")

if __name__ == "__main__":
    main()
