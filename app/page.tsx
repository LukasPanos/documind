import Link from "next/link";

export default function Home() {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-24">
      <div className="max-w-3xl text-center">
        <p className="text-xs uppercase tracking-widest text-indigo-400 mb-4">
          RAG document intelligence
        </p>
        <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight text-white">
          Chat with your documents.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-zinc-400 max-w-2xl mx-auto">
          DocMind is a research assistant for founders and analysts. Upload
          pitch decks, market reports, or any PDF and get cited answers — across
          one document or your entire library.
        </p>
        <div className="mt-10 flex items-center justify-center gap-3">
          <Link
            href="/upload"
            className="inline-flex items-center justify-center h-11 px-5 rounded-full bg-white text-black font-medium hover:bg-zinc-200 transition-colors"
          >
            Upload a PDF
          </Link>
          <Link
            href="/chat"
            className="inline-flex items-center justify-center h-11 px-5 rounded-full border border-zinc-700 text-zinc-200 hover:bg-zinc-900 transition-colors"
          >
            Open chat
          </Link>
        </div>
      </div>
    </div>
  );
}
