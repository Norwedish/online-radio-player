const milestones = [
  { id: "M0", label: "Foundations & spikes", state: "in progress" },
  { id: "M1", label: "Data model", state: "queued" },
  { id: "M2", label: "Media library", state: "queued" },
  { id: "M3", label: "24×1h generator", state: "queued" },
  { id: "M4", label: "Playout core", state: "queued" },
  { id: "M5", label: "Stereo Tool / Icecast", state: "queued" },
  { id: "M6", label: "Interactive controls", state: "queued" },
];

export function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Online Radio Player</p>
          <h1>Control room</h1>
        </div>
        <span className="badge">M0 scaffold</span>
      </header>

      <section className="hero">
        <div>
          <h2>A test tone is on air.</h2>
          <p>
            The M0 walking skeleton streams a 1 kHz tone through the mock Stereo Tool into Icecast.
            The playout engine, real Stereo Tool chain and 24 hourly playlists arrive in the next
            milestones.
          </p>
          <div className="actions">
            <a className="button primary" href="/listen">
              Listen live
            </a>
            <a className="button" href="/admin">
              Admin panel
            </a>
          </div>
        </div>
        <div className="panel">
          <span className="signal" />
          <div>
            <p className="label">API</p>
            <p className="value">http://127.0.0.1:3001/api/health</p>
          </div>
        </div>
      </section>

      <section className="grid">
        {milestones.map((milestone) => (
          <article className="card" key={milestone.id}>
            <p className="card-id">{milestone.id}</p>
            <h3>{milestone.label}</h3>
            <p className="card-state">{milestone.state}</p>
          </article>
        ))}
      </section>

      <footer>
        <span>See PLAN.md and PROGRESS.md for the execution plan.</span>
        <span>Thimeo Stereo Tool is commercial software; binaries are not included.</span>
      </footer>
    </main>
  );
}
