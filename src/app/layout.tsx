import type { Metadata } from "next";
import "./globals.css";
import styles from "./shell.module.css";
import { Sidebar } from "@/components/Sidebar";
import { resolveModel } from "@/lib/model";

export const metadata: Metadata = {
  title: "Triage Control — Claude API Support",
  description:
    "Review queue and reporting for the Claude API support triage agent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* General Sans (Fontshare) + Martian Mono (Google) — both deliberate;
            never fall back to Inter/Roboto/system as the design voice. */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f%5B%5D=general-sans@400,500,600&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <div className={styles.shell}>
          <Sidebar model={resolveModel()} />
          <main className={styles.main}>{children}</main>
        </div>
      </body>
    </html>
  );
}
