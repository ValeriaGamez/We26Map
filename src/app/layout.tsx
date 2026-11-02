import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WE26 Boston | Floor explorer",
  description: "Find WE26 exhibitors and explore their mapped booth spaces in Boston.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
