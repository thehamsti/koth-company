import { redirect } from "next/navigation";
import { OperatorControl } from "@/src/predictions/components/OperatorControl";
import { getOperatorBootstrap } from "@/src/predictions/server-api";

export const dynamic = "force-dynamic";

export default async function PredictionControlPage() {
  const bootstrap = await getOperatorBootstrap();
  if (bootstrap.status === "unauthorized") redirect("/predictions");
  return <OperatorControl initial={bootstrap.state} />;
}
