import Image from "next/image";
import Link from "next/link";
import { defaultTournamentContent, type TournamentContent } from "./content";
import {
  leaderboardEntries as defaultLeaderboardEntries,
  type LeaderboardEntry,
  rankLeaderboard,
} from "./leaderboard";

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
      <Image src="/assets/hydramist-mark.png" alt="" width={44} height={44} />
      <strong>KOTH</strong>
    </span>
  );
}

function Leaderboard({ leaderboardEntries }: { leaderboardEntries: readonly LeaderboardEntry[] }) {
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

export function App({
  content = defaultTournamentContent,
  leaderboardEntries = defaultLeaderboardEntries,
}: {
  content?: TournamentContent;
  leaderboardEntries?: readonly LeaderboardEntry[];
}) {
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
          <Link href="/predictions">Predictions</Link>
          <a href="#sponsors">Sponsors</a>
        </nav>
        <ExternalLink href={content.twitchUrl} className="button button-small">
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
          <p className="season">
            {content.expansion} Season {content.season} · Week {content.week}
          </p>
          <p className="slogan">{content.heroSlogan}</p>
          <div className="hero-actions">
            <ExternalLink href={content.twitchUrl} className="button">
              Watch live on Twitch
            </ExternalLink>
            <a className="button button-secondary" href="#signup">
              How to sign up
            </a>
          </div>
          <p className="signup" id="signup">
            Whisper <strong>{content.hordeCharacter}</strong> (Horde) or{" "}
            <strong>{content.allianceCharacter}</strong> (Alliance) with{" "}
            <code>{content.signupCommand}</code>
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
            {content.rules.map((rule, index) => (
              <li key={rule}>
                <span>{index + 1}</span>
                <p>{rule}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <Leaderboard leaderboardEntries={leaderboardEntries} />
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
                <p>{content.soulstoneText}</p>
                <em>Once per player.</em>
              </div>
            </article>
            <span className="versus">VS</span>
            <article className="power power-red">
              <div>
                <h3>Bloodlust · BL</h3>
                <p>{content.bloodlustText}</p>
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
                  Resurrect <b>{content.resurrectionPrice}</b>
                </h3>
                <p>{content.resurrectionText}</p>
              </article>
              <article>
                <h3>
                  Shuffle queue <b>{content.shufflePrice}</b>
                </h3>
                <p>{content.shuffleText}</p>
              </article>
            </div>
            <ExternalLink href={content.donationUrl} className="donate">
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
              <Image
                src="/assets/restedxp.png"
                alt="RestedXP premium leveling guides — get 10% off"
                width={320}
                height={365}
                loading="eager"
              />
              <span>RestedXP</span>
            </ExternalLink>
            <ExternalLink href="https://uk.weareholy.com/hydra" className="sponsor-card holy">
              <Image
                src="/assets/holy.png"
                alt="HOLY starter set promotion with Hydramist codes"
                width={320}
                height={550}
                loading="eager"
              />
              <span>HOLY</span>
            </ExternalLink>
            <div className="hamsti">
              <Image
                src="/assets/hydramist-mark.png"
                alt=""
                width={130}
                height={130}
                loading="eager"
              />
              <p>{content.sponsorCredit}</p>
            </div>
          </div>
        </div>
      </section>
      <footer>
        <div>
          <h2>Enter the arena</h2>
          <div className="footer-actions">
            <ExternalLink href={content.donationUrl} className="button">
              Donate via Streamlabs
            </ExternalLink>
            <ExternalLink href={content.twitchUrl} className="button button-secondary">
              Open Hydramist on Twitch
            </ExternalLink>
          </div>
        </div>
        <p>
          Hydramist King of the Hill · {content.expansion} Season {content.season}
        </p>
      </footer>
    </main>
  );
}
