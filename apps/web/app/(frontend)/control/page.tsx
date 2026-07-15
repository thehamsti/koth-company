import { redirect } from "next/navigation";

export default function ControlRedirectPage(): never {
  redirect("/predictions/control");
}
