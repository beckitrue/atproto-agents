/**
 * Observer UI (week 3): three panes for the audience —
 *   1. The board (public state, key hidden)
 *   2. Live agent feed (clues, guesses, reasoning — mirrored Bluesky posts)
 *   3. FGA decision log (accepted / denied_authz / denied_rules, color-coded)
 */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>Codenames — Agent Observer</h1>
      <p>
        Board, agent feed, and authorization decision log land here in week 3.
        Engine event source: <code>GET /games/:id/events</code>
      </p>
    </main>
  )
}
