// NOAA's forecast server (NOMADS) shared by the whole site, as a source for gfs.js. NOAA allows
// each address about 120 requests a minute (more gets it blocked for minutes), and every launch
// planner study asks for 2 files, or 33 with the ensemble. So all requests go through one place
// (the Forecasts actor) that:
//   - keeps within a budget per minute, below NOAA's limit, and makes the rest wait their turn,
//     first come first served, except that the main forecasts (2 files a study) go ahead of the
//     ensemble's files (`later`), so a study never waits minutes behind others' ensembles;
//   - says how long files would wait (waitFor), counting the ensemble files promised to studies
//     ahead (reserve), so that a study can do without the ensemble rather than wait too long;
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
    this.sentMain = []; // those of them for main forecasts
    this.active = 0;
    this.queue = []; // resolvers waiting for a turn: main forecasts
    this.later = []; // and ensemble files, which go after them
    this.reserved = 0; // ensemble files promised to studies in line, not asked for yet
    this.timer = null;
    this.blockedUntil = 0;
  }

  /**
   * The decoded fields of the file at `url`; `key` names its run and hour (for unpublished runs).
   * `later`: an ensemble file, which waits for the main forecasts in line.
   */
  fields(url, key = url, { later = false } = {}) {
    const t = this.now();
    const kept = this.files.get(url);
    if (kept && t - kept.at < this.keepMs) return Promise.resolve(kept.fields);
    const missing = this.unpublished.get(key);
    if (missing && t - missing < this.unpublishedMs) return Promise.reject(new NotPublished(`${key} is not published yet`));
    if (this.asking.has(url)) return this.asking.get(url);
    if (t < this.blockedUntil) return Promise.reject(new NoaaBusy("NOAA's forecast server is busy. Try again in a few minutes."));
    const p = this.turn(later)
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

  /**
   * About how long (s) the files at `urls` not already here would wait for their turn (the last
   * of them), asked for now; with `later`, as ensemble files.
   */
  waitFor(urls, { later = false } = {}) {
    const t = this.now();
    if (t < this.blockedUntil) return (this.blockedUntil - t) / 1000;
    const need = urls.filter((u) => !this.asking.has(u) && !(this.files.has(u) && t - this.files.get(u).at < this.keepMs)).length;
    this.prune(t);
    // In line ahead: the main forecasts, and for ensemble files the ensemble files too, promised or asked for.
    const ahead = this.queue.length + (later ? this.later.length + this.reserved : 0);
    let last = ahead + need - 1; // the last one's place in line, from 0
    if (later) {
      // Main forecasts keep coming and go first: about as many as in the last window.
      const share = Math.max(this.perMinute / 4, this.perMinute - this.sentMain.length);
      last = Math.ceil(last * (this.perMinute / share));
    }
    const free = this.perMinute - this.sent.length; // places left in this window
    if (last < free) return 0;
    // Then a place frees up as each request in the window ages out, window after window: first
    // those already sent, then those sent now.
    const k = last - free;
    const i = k % this.perMinute;
    const at = (i < this.sent.length ? this.sent[i] : t) + (Math.floor(k / this.perMinute) + 1) * this.windowMs;
    return Math.max(0, at - t) / 1000;
  }

  /** Promises `n` ensemble files to a study (asked for soon); call the result once they are asked for. */
  reserve(n) {
    this.reserved += n;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.reserved -= n;
      }
    };
  }

  /** Stops asking NOAA for a while, and turns away those waiting. */
  block() {
    this.blockedUntil = this.now() + this.blockMs;
    for (const w of [...this.queue.splice(0), ...this.later.splice(0)]) {
      w.reject(new NoaaBusy("NOAA's forecast server is busy. Try again in a few minutes."));
    }
  }

  prune(t) {
    while (this.sent.length && t - this.sent[0] >= this.windowMs) this.sent.shift();
    while (this.sentMain.length && t - this.sentMain[0] >= this.windowMs) this.sentMain.shift();
  }

  /** Resolves when this request may be sent: within the budget, and few enough at once. */
  turn(later = false) {
    return new Promise((resolve, reject) => {
      (later ? this.later : this.queue).push({ resolve, reject });
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
    const waiting = () => this.queue.length + this.later.length;
    while (waiting() && this.active < this.parallel && this.sent.length < this.perMinute && t >= this.blockedUntil) {
      const main = this.queue.length > 0;
      this.sent.push(t);
      if (main) this.sentMain.push(t);
      this.active++;
      (main ? this.queue : this.later).shift().resolve();
    }
    if (waiting() && !this.timer && this.sent.length >= this.perMinute) {
      // Wake when the oldest request in the window ages out.
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(5, this.sent[0] + this.windowMs - t));
    }
  }
}
