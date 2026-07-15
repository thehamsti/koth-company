import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/react";
import "../../src/styles.css";

export const metadata: Metadata = {
  title: "Hydramist KOTH",
  description: "Hydramist's King of the Hill viewer tournament.",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "70x70" }],
  },
};

export default function FrontendLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
