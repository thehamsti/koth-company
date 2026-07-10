import { leaderboardEntries, rankLeaderboard } from "./leaderboard";

const twitchUrl = "https://www.twitch.tv/hydramist";
const donationUrl = "https://streamlabs.com/hydramist";

function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function BrandMark() {
  return (
    <span className="brand">
      <img src="/assets/hydramist-mark.png" alt="" />
      <strong>KOTH</strong>
    </span>
  );
}

function Leaderboard() {
  const entries = rankLeaderboard(leaderboardEntries);
  return (
    <section className="section leaderboard" id="leaderboard">
      <div className="section-shell">
        <div className="section-heading">
          <span>Best streaks</span>
          <h2>Leaderboard</h2>
          <p>The hill remembers every win.</p>
        </div>
        {entries.length === 0 ? (
          <div className="leaderboard-empty">
            <span className="crown">♛</span>
            <strong>The gates are still closed.</strong>
            <p>Leaderboard updates when matches begin.</p>
          </div>
        ) : (
          <ol className="score-list">
            {entries.map((entry) => (
              <li key={entry.name}>
                <span>{String(entry.rank).padStart(2, "0")}</span>
                <strong>{entry.name}</strong>
                <b>{entry.wins} wins</b>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function App() {
  return (
    <main>
      <header className="site-header">
        <a href="#top" aria-label="KOTH home">
          <BrandMark />
        </a>
        <nav aria-label="Main navigation">
          <a href="#rules">Rules</a>
          <a href="#powerups">Power-ups</a>
          <a href="#leaderboard">Leaderboard</a>
          <a href="#sponsors">Sponsors</a>
        </nav>
        <ExternalLink href={twitchUrl} className="button button-small">
          <span className="live-dot" />
          Watch Hydramist
        </ExternalLink>
      </header>
      <section className="hero" id="top">
        <div className="hero-content">
          <BrandMark />
          <h1>
            <span>King</span>
            <small>of the</small>
            <span>Hill</span>
          </h1>
          <p className="season">TBC Season 2 · Week 1</p>
          <p className="slogan">Win. Stay. Climb.</p>
          <div className="hero-actions">
            <ExternalLink href={twitchUrl} className="button">
              Watch live on Twitch
            </ExternalLink>
            <a className="button button-secondary" href="#signup">
              How to sign up
            </a>
          </div>
          <p className="signup" id="signup">
            Whisper <strong>Hydramon-Spineshatter</strong> (Horde) or{" "}
            <strong>hydraa-Spineshatter</strong> (Alliance) with <code>!koth</code>
          </p>
        </div>
        <a href="#rules" className="scroll-cue" aria-label="Read the tournament rules">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </a>
      </section>
      <section className="section rules" id="rules">
        <div className="section-shell rules-layout">
          <div className="section-heading">
            <span>How it works</span>
            <h2>
              Hold
              <br />
              the hill
            </h2>
          </div>
          <ol className="rule-rail">
            <li>
              <span>1</span>
              <p>
                <strong>Rank 1 players:</strong> Gladiator cutoff rating minimum.
              </p>
            </li>
            <li>
              <span>2</span>
              <p>
                <strong>All other players:</strong> within 150 rating of your season high.
              </p>
            </li>
            <li>
              <span>3</span>
              <p>Play until you lose. Your best streak lands on the leaderboard.</p>
            </li>
            <li>
              <span>4</span>
              <p>The top score wins the donation pool.</p>
            </li>
          </ol>
        </div>
      </section>
      <Leaderboard />
      <section className="section powerups" id="powerups">
        <div className="section-shell">
          <div className="center-heading">
            <h2>Call your cooldown</h2>
          </div>
          <div className="duel">
            <article className="power power-blue">
              <span className="rune">✦</span>
              <div>
                <h3>Soulstone · SS</h3>
                <p>
                  Type <strong>SS</strong> in party chat within 15 seconds after the gates open. If
                  you lose, you stay in.
                </p>
                <em>Once per player.</em>
              </div>
            </article>
            <span className="versus">VS</span>
            <article className="power power-red">
              <div>
                <h3>Bloodlust · BL</h3>
                <p>
                  Type <strong>BL</strong> in party chat within 15 seconds after the gates open. Win
                  before Eyes spawn and it counts as two wins.
                </p>
                <em>Once per player.</em>
              </div>
              <span className="rune">⚑</span>
            </article>
          </div>
          <div className="viewer-panel">
            <h2>Viewers can change the bracket</h2>
            <div className="viewer-actions">
              <article>
                <h3>
                  Resurrect <b>$5 × current wins</b>
                </h3>
                <p>
                  Resurrect an eliminated contestant within two minutes. Maximum once per
                  contestant.
                </p>
              </article>
              <article>
                <h3>
                  Shuffle queue <b>$30</b>
                </h3>
                <p>Randomize the queue order.</p>
              </article>
            </div>
            <ExternalLink href={donationUrl} className="donate">
              Donate directly to the prize pool
            </ExternalLink>
          </div>
        </div>
      </section>
      <section className="section sponsors" id="sponsors">
        <div className="section-shell">
          <div className="center-heading">
            <span>Backed by</span>
            <h2>Sponsors</h2>
          </div>
          <div className="sponsor-grid">
            <ExternalLink href="https://www.restedxp.com/ref/Hydramist/" className="sponsor-card">
              <img
                src="/assets/restedxp.png"
                alt="RestedXP premium leveling guides — get 10% off"
              />
              <span>RestedXP</span>
            </ExternalLink>
            <ExternalLink href="https://uk.weareholy.com/hydra" className="sponsor-card holy">
              <img src="/assets/holy.png" alt="HOLY starter set promotion with Hydramist codes" />
              <span>HOLY</span>
            </ExternalLink>
            <div className="hamsti">
              <img src="/assets/hydramist-mark.png" alt="" />
              <p>
                KOTH is sponsored by <strong>Hamsti.</strong>
              </p>
            </div>
          </div>
        </div>
      </section>
      <footer>
        <div>
          <h2>Enter the arena</h2>
          <div className="footer-actions">
            <ExternalLink href={donationUrl} className="button">
              Donate via Streamlabs
            </ExternalLink>
            <ExternalLink href={twitchUrl} className="button button-secondary">
              Open Hydramist on Twitch
            </ExternalLink>
          </div>
        </div>
        <p>Hydramist King of the Hill · TBC Season 2</p>
      </footer>
    </main>
  );
}
