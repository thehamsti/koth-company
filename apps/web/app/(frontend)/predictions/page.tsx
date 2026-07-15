import type { Metadata } from "next";
import { PredictionsClient } from "@/src/predictions/components/PredictionsClient";
import { getPredictionBootstrap } from "@/src/predictions/server-api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "KOTH Forecast Exchange" };

export default async function PredictionsPage() {
  return <PredictionsClient initial={await getPredictionBootstrap()} />;
}
