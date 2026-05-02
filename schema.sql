-- Run this once in the Supabase SQL editor

CREATE TABLE daily_puzzles (
    id              SERIAL PRIMARY KEY,
    puzzle_date     DATE UNIQUE NOT NULL,
    answer_tmdb_id  INTEGER NOT NULL,
    answer_title    TEXT NOT NULL,
    answer_poster   TEXT,
    clues           JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Allow anonymous reads (for the frontend)
ALTER TABLE daily_puzzles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read"
    ON daily_puzzles FOR SELECT
    USING (true);

-- Practice puzzle pool (no date — picked randomly by the game)
CREATE TABLE practice_puzzles (
    id              SERIAL PRIMARY KEY,
    answer_tmdb_id  INTEGER NOT NULL,
    answer_title    TEXT NOT NULL,
    answer_poster   TEXT,
    clues           JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE practice_puzzles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read"
    ON practice_puzzles FOR SELECT
    USING (true);
