"""
Manually add a puzzle for any date.

Usage:
  python add_puzzle.py --date 2026-05-01 --movie "The Godfather"
  python add_puzzle.py --date 2026-05-01 --id 238
"""

import argparse, sys
from dotenv import load_dotenv
load_dotenv()
import puzzle_generator as pg


def search_movie(query):
    results = pg.tmdb("/search/movie", query=query, include_adult="false", page=1)
    movies = results.get("results", [])
    if not movies:
        print(f"No results found for '{query}'")
        sys.exit(1)

    print(f"\nResults for '{query}':")
    for i, m in enumerate(movies[:8]):
        year = (m.get("release_date") or "")[:4]
        print(f"  [{i + 1}] {m['title']} ({year})  — TMDB ID: {m['id']}")

    choice = input("\nEnter number (Enter = #1): ").strip()
    idx = int(choice) - 1 if choice else 0
    return movies[idx]


def build_with_retries(movie, force=False):
    """Try up to 5 times (random clue selection may vary)."""
    for attempt in range(5):
        puzzle = pg.build_puzzle(movie, force=force)
        if puzzle:
            return puzzle
        if attempt == 0:
            print("  First attempt failed, retrying with different hint selections...")
    return None


def main():
    parser = argparse.ArgumentParser(description="Manually add a CineClue puzzle")
    parser.add_argument("--date",  required=True, help="Puzzle date  YYYY-MM-DD")
    parser.add_argument("--movie", help="Movie title to search")
    parser.add_argument("--id",    type=int, help="TMDB movie ID (skips search)")
    parser.add_argument("--force", action="store_true",
                        help="Allow franchise/sequel films (skips that check)")
    args = parser.parse_args()

    if not args.movie and not args.id:
        parser.error("Provide --movie 'Title' or --id 12345")

    # Resolve movie
    if args.id:
        movie = pg.tmdb(f"/movie/{args.id}")
    else:
        movie = search_movie(args.movie)

    year = (movie.get("release_date") or "")[:4]
    print(f"\nSelected: {movie['title']} ({year})  — ID: {movie['id']}")

    # Build clues
    print("Building clues...")
    puzzle = build_with_retries(movie, force=args.force)

    if not puzzle:
        # Check if franchise filter is the cause
        details = pg.get_movie_details(movie["id"])
        if details.get("belongs_to_collection") and not args.force:
            coll = details["belongs_to_collection"]["name"]
            print(f"\n  Skipped: '{movie['title']}' belongs to '{coll}'.")
            print("  Re-run with --force to add it anyway.")
        else:
            print("\n  Could not build a valid puzzle (not enough clue candidates).")
        sys.exit(1)

    # Preview
    print(f"\nPuzzle for {args.date}:")
    print(f"  Answer : {puzzle['answer_title']}")
    print(f"  Clues  :")
    for c in puzzle["clues"]:
        conn = c.get("connection", "")
        print(f"    {c['category']:<9} {c['hint_title']:<40}  ({conn})")

    confirm = input("\nSave? [Y/n]: ").strip().lower()
    if confirm in ("", "y", "yes"):
        pg.upsert_puzzle(args.date, puzzle)
    else:
        print("Cancelled.")


if __name__ == "__main__":
    main()
