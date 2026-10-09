import { recentQueries } from './recent.ts';

export function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const recent = recentQueries();
  return (
    <div className="search-empty">
      {recent.length > 0 && (
        <section>
          <h3>Recent</h3>
          <ul className="search-recent">
            {recent.map((x) => (
              <li key={x}>
                <button type="button" onClick={() => onPick(x)}>
                  {x}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Syntax</h3>
        <table className="search-syntax">
          <tbody>
            <tr>
              <td>
                <code>foo bar</code>
              </td>
              <td>both, anywhere in one event, any case</td>
            </tr>
            <tr>
              <td>
                <code>"foo bar"</code>
              </td>
              <td>that exact phrase</td>
            </tr>
            <tr>
              <td>
                <code>/fo+\.ts/</code>
              </td>
              <td>regex, case-insensitive unless you give flags</td>
            </tr>
            <tr>
              <td>
                <code>project:brainhouse</code>
              </td>
              <td>repo name, or any part of the session's directory</td>
            </tr>
            <tr>
              <td>
                <code>account:pw</code>
              </td>
              <td>which Claude account</td>
            </tr>
            <tr>
              <td>
                <code>role:out</code>
              </td>
              <td>you, ai, thinking, tool (calls), out (results), error</td>
            </tr>
            <tr>
              <td>
                <code>tool:Bash</code>
              </td>
              <td>tool name</td>
            </tr>
            <tr>
              <td>
                <code>after:7d before:2026-09-01</code>
              </td>
              <td>event time</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function NoResults({
  loading,
  q,
  tooBroad,
  error,
}: {
  loading: boolean;
  q: string;
  tooBroad: boolean;
  error: string | null;
}) {
  if (error) return <div className="search-empty search-error">{error}</div>;
  if (loading) return <div className="search-empty">Searching…</div>;
  if (tooBroad)
    return (
      <div className="search-empty">
        That matches too much to finish in time. Add a word or a filter to narrow it.
      </div>
    );
  const filters = q.split(/\s+/).filter((p) => /^[a-z]+:\S/i.test(p) && !/^https?:/i.test(p));
  return (
    <div className="search-empty">
      No matches.
      {filters.length > 0 && (
        <>
          {' '}
          Filters in force:{' '}
          {filters.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </>
      )}
    </div>
  );
}
