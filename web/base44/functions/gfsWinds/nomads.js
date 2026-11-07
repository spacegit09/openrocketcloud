// NOAA's forecast server (NOMADS) shared by the whole site, as a source for gfs.js. NOAA allows
// each address about 120 requests a minute (more gets it blocked for minutes), and every launch
// planner study asks for 2 files, or 33 with the ensemble. So all requests go through one place
// (the Forecasts actor) that:
//   - keeps within a budget per minute, below NOAA's limit, and makes the rest wait their turn,
//     first come first served;
//   - keeps what it downloaded for 6 hours (a run's files do not change), so everyone planning in
//     the same 1° square (a club's launch field, say) shares them, and asks once for files several
//     people want at the same moment;
//   - remembers for a few minutes which runs are not published yet, rather than asking again;
//   - stops asking for a few minutes if NOAA refuses (NoaaBusy), answering from what it has.
import { NoaaBusy, NotPublished, download } from './gfs.js';

const MINUTE = 60_000;

export class NomadsSource {
  constructor({ fetch: fetchFn = fetch, perMinute = 100, parallel = 8, windowMs = MINUTE, keepMs = 6 * 3600e3,
    unpublishedMs = 5 * MINUTE, blockMs = 5 * MINUTE, maxFiles = 4000, now = () => Date.now() } = {}) {
    Object.assign(this, { fetchFn, perMinute, parallel, windowMs, keepMs, unpublishedMs, blockMs, maxFiles, now });
    this.files = new Map(); // url -> { at, fields }
    this.asking = new Map(); // url -> promise of fields
    this.unpublished = new Map(); // key (product, run, hour) -> when found missing
    this.sent = []; // when each request in the last window was sent
    this.active = 0;
    this.queue = []; // resolvers waiting for a turn
    this.timer = null;
    this.blockedUntil = 0;
  }

  /** The decoded fields of the file at `url`; `key` names its run and hour (for unpublished runs). */
  fields(url, key = url) {
    const t = this.now();
    const kept = this.files.get(url);
    if (kept && t - kept.at < this.keepMs) return Promise.resolve(kept.fields);
    const missing = this.unpublished.get(key);
    if (missing && t - missing < this.unpublishedMs) return Promise.reject(new NotPublished(`${key} is not published yet`));
    if (this.asking.has(url)) return this.asking.get(url);
    if (t < this.blockedUntil) return Promise.reject(new NoaaBusy("NOAA's forecast server is busy. Try again in a few minutes."));
    const p = this.turn()
      .then(async () => {
        try {
          const fields = await download(url, this.fetchFn);
          if (this.files.size >= this.maxFiles) this.files.delete(this.files.keys().next().value);
          this.files.set(url, { at: this.now(), fields });
          return fields;
        } catch (e) {
          // Noted before the next request may go.
          if (e instanceof NotPublished) this.unpublished.set(key, this.now());
          if (e instanceof NoaaBusy) this.block();
          throw e;
        } finally {
          this.release();
        }
      })
      .finally(() => this.asking.delete(url));
    this.asking.set(url, p);
    return p;
  }

  /** About how long (s) asking for the files at `urls` not already here would wait for a turn. */
  waitFor(urls) {
    const t = this.now();
    if (t < this.blockedUntil) return (this.blockedUntil - t) / 1000;
    const need = urls.filter((u) => !this.asking.has(u) && !(this.files.has(u) && t - this.files.get(u).at < this.keepMs)).length;
    this.prune(t);
    const over = this.sent.length + this.queue.length + need - this.perMinute;
    if (over <= 0) return 0;
    // Each window lets `perMinute` more through; the first frees up as the oldest request ages out.
    const firstFree = this.sent.length ? Math.max(0, this.sent[0] + this.windowMs - t) : 0;
    return (firstFree + Math.floor((over - 1) / this.perMinute) * this.windowMs) / 1000;
  }

  /** Stops asking NOAA for a while, and turns away those waiting. */
  block() {
    this.blockedUntil = this.now() + this.blockMs;
    for (const w of this.queue.splice(0)) w.reject(new NoaaBusy("NOAA's forecast server is busy. Try again in a few minutes."));
  }

  prune(t) {
    while (this.sent.length && t - this.sent[0] >= this.windowMs) this.sent.shift();
  }

  /** Resolves when this request may be sent: within the budget, and few enough at once. */
  turn() {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.pump();
    });
  }

  release() {
    this.active--;
    this.pump();
  }

  pump() {
    const t = this.now();
    this.prune(t);
    while (this.queue.length && this.active < this.parallel && this.sent.length < this.perMinute && t >= this.blockedUntil) {
      this.sent.push(t);
      this.active++;
      this.queue.shift().resolve();
    }
    if (this.queue.length && !this.timer && this.sent.length >= this.perMinute) {
      // Wake when the oldest request in the window ages out.
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(5, this.sent[0] + this.windowMs - t));
    }
  }
}
