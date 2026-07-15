"use client";

export default function PredictionsError({ reset }: { reset: () => void }) {
  return (
    <main className="prediction-page">
      <div className="prediction-empty">
        <strong>The exchange is temporarily unavailable.</strong>
        <button onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
