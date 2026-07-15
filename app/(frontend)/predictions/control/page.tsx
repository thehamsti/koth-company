import { redirect } from "next/navigation";
import { OperatorControl } from "@/src/predictions/components/OperatorControl";
import { getViewer } from "@/src/predictions/http";
import { getOperatorState } from "@/src/predictions/services/operator";

export const dynamic = "force-dynamic";

export default async function PredictionControlPage() {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== "admin") redirect("/predictions");
  return <OperatorControl initial={await getOperatorState()} />;
}
