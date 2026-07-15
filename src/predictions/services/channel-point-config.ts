const crownDenominations = [1, 10, 100, 1_000, 10_000] as const;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function getChannelPointsToCrownsRate(): number {
  return positiveInteger("CHANNEL_POINTS_TO_CROWNS_RATE", 1_000);
}

export function getChannelPointsEventCap(): number {
  return positiveInteger("CHANNEL_POINTS_MAX_PER_USER_PER_EVENT", 10_000);
}

export function getChannelPointRewardDenominations(): Array<{
  title: string;
  cost: number;
  crowns: string;
}> {
  const rate = getChannelPointsToCrownsRate();
  const cap = getChannelPointsEventCap();
  if (rate > Number.MAX_SAFE_INTEGER / crownDenominations.at(-1)!) {
    throw new Error("CHANNEL_POINTS_TO_CROWNS_RATE is too large.");
  }
  const denominations = crownDenominations
    .map((crowns) => ({
      title: `${crowns.toLocaleString("en-US")} ${crowns === 1 ? "Crown" : "Crowns"}`,
      cost: crowns * rate,
      crowns: String(crowns),
    }))
    .filter(({ cost }) => cost <= cap);

  if (denominations.length === 0) {
    throw new Error(
      "CHANNEL_POINTS_MAX_PER_USER_PER_EVENT must be at least CHANNEL_POINTS_TO_CROWNS_RATE.",
    );
  }
  return denominations;
}
