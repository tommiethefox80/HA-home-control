// Every request to the app goes through Home Assistant's ingress, which answers 401 when the
// page's session has run out: usually the phone app coming back from the background, a few
// seconds before Home Assistant renews it. The request never reached Home Control, so it's safe
// to try again; if it still can't get through, say how to fix it rather than "Request failed (401)".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SESSION_ENDED = 'Home Assistant\'s session for this page ran out, so that didn\'t go through. Reload the page (or close Home Control and open it again), then try once more.';

export async function hcFetch(input, init) {
  let res = await fetch(input, init);
  for (const wait of [1000, 2000, 3000]) {
    if (res.status !== 401) return res;
    await sleep(wait);
    res = await fetch(input, init);
  }
  if (res.status !== 401) return res;
  return new Response(JSON.stringify({ error: SESSION_ENDED }), { status: 401, headers: { 'content-type': 'application/json' } });
}
