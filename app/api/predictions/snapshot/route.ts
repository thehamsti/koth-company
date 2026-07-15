import { NextResponse } from "next/server";
import { getViewer, apiError } from "@/src/predictions/http";
import { getPredictionSnapshot } from "@/src/predictions/services/trading";

export async function GET() {
  try {
    const viewer = await getViewer();
    return NextResponse.json(await getPredictionSnapshot(viewer?.id));
  } catch (error) {
    return apiError(error);
  }
}
