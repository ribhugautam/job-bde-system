import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job & Freelance Pipeline",
  description: "Daily remote job matching and freelance/contract outreach pipeline",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
