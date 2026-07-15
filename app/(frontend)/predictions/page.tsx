import type { Metadata } from "next";
import { PredictionsClient } from "@/src/predictions/components/PredictionsClient";
import { getViewer } from "@/src/predictions/http";
import { getPredictionSnapshot } from "@/src/predictions/services/trading";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "KOTH Forecast Exchange" };

export default async function PredictionsPage() {
  const viewer = await getViewer();
  const initial = await getPredictionSnapshot(viewer?.id);
  return <PredictionsClient initial={initial} />;
}
