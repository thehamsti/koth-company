import { requireAdmin } from "@/src/predictions/http";
import {
  setRewardEnabled,
  setupTwitchRewards,
  teardownTwitchRewards,
} from "@/src/predictions/services/channel-points";
import { z } from "zod";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    await requireAdmin();
    await setupTwitchRewards();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Setup failed." },
      { status: 500 },
    );
  }
}

const patchBody = z.object({ enabled: z.boolean() });

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const { enabled } = patchBody.parse(await request.json());
    await setRewardEnabled(enabled);
    return NextResponse.json({ success: true, enabled });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await teardownTwitchRewards();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Teardown failed." },
      { status: 500 },
    );
  }
}
