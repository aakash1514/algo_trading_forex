// A replay session's title, as the user typed it. Plain text, checked on the server:
//   - no control characters (\p{Cc}: newlines, tabs, NUL, DEL, C1), no format characters
//     (\p{Cf}: e.g. U+202E RIGHT-TO-LEFT OVERRIDE, which can make a title display as
//     something else, or zero-width characters) and no line/paragraph separators
//     (U+2028/U+2029). Checked on the text as sent, so a trailing newline is refused too.
//   - trimmed, then 1-60 characters, counted as Unicode code points (not bytes, not UTF-16
//     units: an emoji is one), as Postgres char_length counts them (the column's CHECK)
//   - empty or null means "no title": the session gets the auto name
export const TITLE_MAX_CHARS = 60;

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// error is null exactly when the title is acceptable (title null: the auto name)
export interface TitleResult { title: string | null; error: string | null }

export function normalizeTitle(raw: unknown): TitleResult {
  if (raw === null || raw === undefined) return { title: null, error: null };
  if (typeof raw !== 'string') return { title: null, error: 'title must be text' };
  if (FORBIDDEN.test(raw)) return { title: null, error: 'title must not contain control or invisible formatting characters' };
  const title = raw.trim();
  if (title === '') return { title: null, error: null };
  if ([...title].length > TITLE_MAX_CHARS) return { title: null, error: `title must be at most ${TITLE_MAX_CHARS} characters` };
  return { title, error: null };
}
