import { FormEvent } from "react";

type ComposerProps = {
  value: string;
  isSubmitting: boolean;
  onChange(value: string): void;
  onSubmit(): void;
};

export function Composer({
  value,
  isSubmitting,
  onChange,
  onSubmit,
}: ComposerProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <section className="panel kickoff" aria-labelledby="composer-title">
      <div className="pane-head">
        <h2 id="composer-title">Start new work</h2>
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          aria-label="Describe what you'd like Arcade to do"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Describe what you'd like Arcade to do..."
          rows={3}
        />
        <button
          className="btn primary composer-send"
          type="submit"
          disabled={value.trim().length === 0 || isSubmitting}
        >
          {isSubmitting ? "Running" : "Run"}
        </button>
      </form>
    </section>
  );
}
