import { NextResponse } from "next/server";
import { authenticateAutomationRequest } from "@/src/predictions/automation/http";
import { getAutomationState } from "@/src/predictions/automation/service";
import { apiError } from "@/src/predictions/http";

export async function GET(request: Request) {
  try {
    await authenticateAutomationRequest(request, "");
    return NextResponse.json(await getAutomationState());
  } catch (error) {
    return apiError(error);
  }
}
