import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireViewer } from "@/src/predictions/http";
import { createTradeQuote } from "@/src/predictions/services/trading";

const quoteInput = z.object({
  marketId: z.uuid(),
  outcomeId: z.uuid(),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,8})?$/),
});

export async function POST(request: Request) {
  try {
    const viewer = await requireViewer();
    const input = quoteInput.parse(await request.json());
    return NextResponse.json(await createTradeQuote({ userId: viewer.id, ...input }));
  } catch (error) {
    return apiError(error);
  }
}
