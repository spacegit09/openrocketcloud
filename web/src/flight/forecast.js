// The launch planner's forecast winds: from the site's Forecasts actor (base44/actors/Forecasts),
// which everyone shares, staying under NOAA's limit on requests and reusing forecasts already
// downloaded; or, if it cannot be reached, from the gfsWinds function directly. Local tests
// (the stand-in hub) use the function.
import { base44 } from '../base44.js';
import { testHub } from '../room-client.js';

/** { lat, lon, time, ensemble } -> the forecast (see gfsWinds); onProgress(text) while it waits. */
export async function forecastWinds(request, onProgress = () => {}) {
  if (!testHub()) {
    try {
      return await viaActor(request, onProgress);
    } catch (e) {
      if (!e.unreachable) throw e;
    }
  }
  return viaFunction(request);
}

async function viaFunction(request) {
  let wind;
  try {
    wind = (await base44.functions.invoke('gfsWinds', request)).data;
  } catch (e) {
    throw new Error(e.response?.data?.error ?? 'Could not get the forecast. Try again in a moment.');
  }
  if (wind?.error) throw new Error(wind.error);
  return wind;
}

function viaActor(request, onProgress) {
  const rid = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let conn = null;
    let greeted = false;
    let done = false;
    const unreachable = (why) => Object.assign(new Error(why), { unreachable: true });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(greeting);
      clearTimeout(overall);
      try {
        conn?.close();
      } catch {
        // already closed
      }
      fn(value);
    };
    // No greeting: the actor is not there (or not reachable), so the function answers instead.
    const greeting = setTimeout(() => finish(reject, unreachable('no answer')), 10_000);
    const overall = setTimeout(() => finish(reject, new Error('The forecast took too long. Try again in a moment.')), 180_000);
    try {
      conn = base44.actors.Forecasts('noaa').connect({ id: rid });
    } catch (e) {
      finish(reject, unreachable(e.message));
      return;
    }
    conn.subscribe((msg) => {
      if (msg?.type === 'hi' && !greeted) {
        greeted = true;
        clearTimeout(greeting);
        conn.send({ type: 'forecast', rid, ...request });
      } else if (msg?.rid === rid && msg.type === 'progress') {
        onProgress(msg.text);
      } else if (msg?.rid === rid && msg.type === 'reply') {
        if (msg.ok) finish(resolve, msg.data);
        else finish(reject, new Error(msg.error));
      }
    });
    // Lost before the answer: the function answers instead.
    conn.ws?.addEventListener?.('close', () => finish(reject, unreachable('closed')));
  });
}
