"""One-off: generate today's puzzle."""
import datetime, random
from dotenv import load_dotenv
load_dotenv()
import puzzle_generator as pg

used = pg.fetch_used_ids()
pool = pg.fetch_popular_pool(pages=15)
random.shuffle(pool)

today = datetime.date.today().isoformat()
print(f"Generating puzzle for {today}...")

for movie in pool:
    if movie["id"] in used:
        continue
    print(f"  Trying: {movie['title']}")
    try:
        puzzle = pg.build_puzzle(movie)
    except Exception as e:
        print(f"    skip: {e}")
        continue
    if puzzle:
        pg.upsert_puzzle(today, puzzle)
        break
