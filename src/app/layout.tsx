import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "WE26 | Company route planner",
  description: "Find exhibitors and explore their mapped booth spaces in Boston.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}
        <Analytics />
      </body>
    </html>
  );
}
