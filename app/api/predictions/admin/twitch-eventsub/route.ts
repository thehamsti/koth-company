import { requireAdmin } from "@/src/predictions/http";
import { syncTwitchEventSub } from "@/src/predictions/services/channel-points";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    await requireAdmin();
    await syncTwitchEventSub();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed." },
      { status: 500 },
    );
  }
}
