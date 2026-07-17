import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import { defaultTournamentContent, type TournamentContent } from "./content";
import {
  leaderboardEntries as defaultLeaderboardEntries,
  type LeaderboardEntry,
  rankLeaderboard,
} from "./leaderboard";
import { SiteMotion } from "./Motion";

const reveal = (i: number) => ({ "--i": i }) as CSSProperties;

const EMBERS = [
  { x: 4, s: 3, dur: 12, delay: -1, dx: 52 },
  { x: 11, s: 2, dur: 9, delay: -6, dx: -38 },
  { x: 17, s: 4, dur: 14, delay: -3, dx: 64 },
  { x: 24, s: 2, dur: 10, delay: -8, dx: -46 },
  { x: 30, s: 3, dur: 11, delay: -4, dx: 30 },
  { x: 37, s: 2, dur: 13, delay: -9, dx: -58 },
  { x: 44, s: 4, dur: 12, delay: -2, dx: 44 },
  { x: 51, s: 2, dur: 9, delay: -7, dx: -34 },
  { x: 58, s: 3, dur: 15, delay: -5, dx: 56 },
  { x: 64, s: 2, dur: 10, delay: -1, dx: -42 },
  { x: 71, s: 4, dur: 13, delay: -10, dx: 38 },
  { x: 78, s: 2, dur: 11, delay: -4, dx: -52 },
  { x: 85, s: 3, dur: 12, delay: -8, dx: 46 },
  { x: 91, s: 2, dur: 9, delay: -3, dx: -36 },
  { x: 96, s: 4, dur: 14, delay: -6, dx: 40 },
] as const;

const TICKER_WORDS = ["Win", "Stay", "Climb", "Hold the hill"] as const;

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

function Hero({ content }: { content: TournamentContent }) {
  return (
    <section className="hero" id="top">
      <div className="hero-parallax" aria-hidden="true">
        <div className="hero-bg" />
      </div>
      <div className="hero-shade" aria-hidden="true" />
      <div className="embers" aria-hidden="true">
        {EMBERS.map((ember) => (
          <i
            key={`${ember.x}-${ember.delay}`}
            style={
              {
                "--x": `${ember.x}%`,
                "--s": `${ember.s}px`,
                "--dur": `${ember.dur}s`,
                "--delay": `${ember.delay}s`,
                "--dx": `${ember.dx}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="hero-content">
        <p className="hero-eyebrow">Hydramist arena event</p>
        <h1 className="hero-title">
          <span className="mask">
            <span className="line">King</span>
          </span>
          <span className="mask mask-of">
            <small className="line">of the</small>
          </span>
          <span className="mask">
            <span className="line line-gold">Hill</span>
          </span>
        </h1>
        <p className="season">
          <i className="chip-dot" aria-hidden="true" />
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
  );
}

function Ticker() {
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {[0, 1].map((half) => (
          <div className="ticker-set" key={half}>
            {[0, 1, 2].map((rep) =>
              TICKER_WORDS.map((word) => (
                <span className="ticker-item" key={`${rep}-${word}`}>
                  <b>{word}</b>
                  <i>✦</i>
                </span>
              )),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Rules({ content }: { content: TournamentContent }) {
  return (
    <section className="section rules" id="rules">
      <div className="section-shell rules-layout">
        <div className="section-heading reveal" style={reveal(0)}>
          <span>How it works</span>
          <h2>
            Hold
            <br />
            the hill
          </h2>
          <p>Four laws of the gauntlet. Break none of them.</p>
        </div>
        <ol className="rule-rail reveal">
          {content.rules.map((rule, index) => (
            <li key={rule} className="reveal" style={reveal(index)}>
              <span>{index + 1}</span>
              <p>{rule}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Leaderboard({ leaderboardEntries }: { leaderboardEntries: readonly LeaderboardEntry[] }) {
  const entries = rankLeaderboard(leaderboardEntries);
  return (
    <section className="section leaderboard" id="leaderboard">
      <div className="section-shell">
        <div className="section-heading reveal" style={reveal(0)}>
          <span>Best streaks</span>
          <h2>Leaderboard</h2>
          <p>The hill remembers every win.</p>
        </div>
        {entries.length === 0 ? (
          <div className="leaderboard-empty reveal" style={reveal(1)}>
            <span className="crown">♛</span>
            <strong>The gates are still closed.</strong>
            <p>Leaderboard updates when matches begin.</p>
          </div>
        ) : (
          <ol className="score-list">
            {entries.map((entry, index) => (
              <li key={entry.name} className="reveal" style={reveal(index)}>
                <span className="rank">{String(entry.rank).padStart(2, "0")}</span>
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

function Powerups({ content }: { content: TournamentContent }) {
  return (
    <section className="section powerups" id="powerups">
      <div className="section-shell">
        <div className="center-heading reveal" style={reveal(0)}>
          <span>Two cooldowns, one choice</span>
          <h2>Call your cooldown</h2>
        </div>
        <div className="duel">
          <article className="power power-blue reveal" style={reveal(0)}>
            <span className="rune" aria-hidden="true">
              ✦
            </span>
            <div>
              <p className="power-tag">Defensive cooldown</p>
              <h3>Soulstone · SS</h3>
              <p>{content.soulstoneText}</p>
              <em>Once per player.</em>
            </div>
          </article>
          <span className="versus" aria-hidden="true">
            VS
          </span>
          <article className="power power-red reveal" style={reveal(1)}>
            <div>
              <p className="power-tag">Offensive cooldown</p>
              <h3>Bloodlust · BL</h3>
              <p>{content.bloodlustText}</p>
              <em>Once per player.</em>
            </div>
            <span className="rune" aria-hidden="true">
              ⚑
            </span>
          </article>
        </div>
        <div className="viewer-panel reveal" style={reveal(2)}>
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
  );
}

function Sponsors({ content }: { content: TournamentContent }) {
  return (
    <section className="section sponsors" id="sponsors">
      <div className="section-shell">
        <div className="center-heading reveal" style={reveal(0)}>
          <span>Backed by</span>
          <h2>Sponsors</h2>
        </div>
        <div className="sponsor-grid reveal" style={reveal(1)}>
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
            <span className="hamsti-mark">
              <span className="ring" aria-hidden="true" />
              <Image
                src="/assets/hydramist-mark.png"
                alt=""
                width={130}
                height={130}
                loading="eager"
              />
            </span>
            <p>{content.sponsorCredit}</p>
          </div>
        </div>
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
      <SiteMotion />
      <div className="grain" aria-hidden="true" />
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
      <Hero content={content} />
      <Ticker />
      <Rules content={content} />
      <Leaderboard leaderboardEntries={leaderboardEntries} />
      <Powerups content={content} />
      <Sponsors content={content} />
      <footer>
        <div className="reveal" style={reveal(0)}>
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
