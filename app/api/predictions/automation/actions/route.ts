import { NextResponse } from "next/server";
import { automationAction } from "@/src/predictions/automation/contracts";
import { authenticateAutomationRequest } from "@/src/predictions/automation/http";
import { runAutomationAction } from "@/src/predictions/automation/service";
import { apiError } from "@/src/predictions/http";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const idempotencyKey = await authenticateAutomationRequest(request, rawBody);
    const action = automationAction.parse(JSON.parse(rawBody));
    return NextResponse.json(await runAutomationAction(action, idempotencyKey));
  } catch (error) {
    return apiError(error);
  }
}
