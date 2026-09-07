"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <p>Could not load this invoice.</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
