// Read-only checks of public submission artifacts. Never loads credentials.
const urls = [
  "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data/index.json",
  "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data/indexer/snapshot.json",
  "https://backstop-smoky.vercel.app",
];
await Promise.all(urls.map(async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const raw = await res.text();
    let details = { bytes: raw.length };
    if (url.endsWith("index.json")) {
      const body = JSON.parse(raw);
      details = { updatedAt: body.updatedAt, versions: Object.entries(body.versions ?? {}).map(([id, v]) => ({ id, rounds: v.rounds.length, last: v.rounds.at(-1) })) };
    } else if (url.endsWith("snapshot.json")) {
      const body = JSON.parse(raw);
      details = { takenAt: body.takenAt, block: body.block, protocol: body.data?.ProtocolIndex };
    }
    console.log(JSON.stringify({ url, status: res.status, ...details }));
  } catch (error) { console.log(JSON.stringify({ url, error: error.message })); }
}));
