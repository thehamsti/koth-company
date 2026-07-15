export default function KothDashboard() {
  return (
    <section className="koth-dashboard">
      <div className="koth-dashboard__eyebrow">Hydramist tournament operations</div>
      <div className="koth-dashboard__hero">
        <div>
          <h1>Control the hill.</h1>
          <p>
            Set the active expansion and event number, tune tournament copy, then update winning
            streaks as matches finish.
          </p>
        </div>
        <a href="/" target="_blank" rel="noreferrer">
          View live site ↗
        </a>
      </div>
      <div className="koth-dashboard__actions">
        <a href="/admin/globals/tournament-settings">
          <span>01</span>
          <strong>Tournament control</strong>
          <small>Expansion, season, week, copy, and links</small>
        </a>
        <a href="/admin/collections/leaderboard-entries">
          <span>02</span>
          <strong>Leaderboard</strong>
          <small>Search participants and record their best streaks</small>
        </a>
        <a href="/admin/collections/participants">
          <span>03</span>
          <strong>Participants</strong>
          <small>Maintain the reusable player directory</small>
        </a>
      </div>
    </section>
  );
}
