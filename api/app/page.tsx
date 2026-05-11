export default function Home() {
  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>fliver</h1>
      <p>RDM driver forecast — personal API.</p>
      <ul>
        <li>
          <a href="/api/today">GET /api/today</a> — top 3 windows for next 24h
        </li>
        <li>POST /api/cron/sync-arrivals — protected; AeroAPI sync entrypoint</li>
        <li>POST /api/shifts — log a shift</li>
        <li>POST /api/rides — log a ride</li>
      </ul>
    </main>
  );
}
