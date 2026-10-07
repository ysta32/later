import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { errorMessage } from "../app.tsx";
export default function Ask() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Awaited<ReturnType<typeof api.ask>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section class="narrow">
      <p class="eyebrow">Connect the dots</p>
      <h1>Ask your library.</h1>
      <p class="muted">Revisit the ideas you’ve collected. Answers include sources from your reading.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!question.trim()) return;
          setBusy(true);
          setError("");
          setAnswer(null);
          try {
            setAnswer(await api.ask(question.trim()));
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Your question
          <textarea
            required
            rows={3}
            placeholder="What have I saved about building better habits?"
            value={question}
            onInput={(e) => setQuestion(e.currentTarget.value)}
          />
        </label>
        <button class="primary" disabled={busy || !question.trim()}>
          {busy ? "Looking through your library…" : "Ask your library"}
        </button>
      </form>
      {error && (
        <p role="alert" class="notice">
          {error}
        </p>
      )}
      {answer && (
        <article class="panel">
          <p class="eyebrow">{answer.method === "search" ? "Search-based answer" : "AI-assisted answer"}</p>
          <p class="answer">{answer.answer}</p>
          <h2>From your reading</h2>
          {answer.sources.length ? (
            <ul>
              {answer.sources.map((source) => (
                <li key={source.id}>
                  <a href={`#/read/${encodeURIComponent(source.id)}`}>{source.title || source.url}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p>No sources found. Try another question.</p>
          )}
        </article>
      )}
    </section>
  );
}
