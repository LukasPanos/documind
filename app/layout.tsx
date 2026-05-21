import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DocMind — Chat with your documents",
  description:
    "RAG document intelligence for founders and analysts. Upload pitch decks, market reports, or any PDF and get cited answers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0a0a0b] text-zinc-100">
        <header className="border-b border-zinc-800/80 bg-[#0a0a0b]/80 backdrop-blur sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between">
            <Link
              href="/"
              className="flex items-center gap-2 text-zinc-100 font-semibold tracking-tight"
            >
              <span className="inline-block h-6 w-6 rounded bg-gradient-to-br from-indigo-400 to-fuchsia-500" />
              DocMind
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/upload"
                className="px-3 py-1.5 rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition-colors"
              >
                Upload
              </Link>
              <Link
                href="/chat"
                className="px-3 py-1.5 rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition-colors"
              >
                Chat
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
