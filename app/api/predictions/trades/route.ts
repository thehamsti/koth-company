import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireViewer } from "@/src/predictions/http";
import { executeTrade } from "@/src/predictions/services/trading";

const tradeInput = z.object({ quoteId: z.uuid(), idempotencyKey: z.string().min(8).max(100) });

export async function POST(request: Request) {
  try {
    const viewer = await requireViewer();
    const input = tradeInput.parse(await request.json());
    return NextResponse.json(await executeTrade({ userId: viewer.id, ...input }));
  } catch (error) {
    return apiError(error);
  }
}
