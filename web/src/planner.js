// The Launch Planner: a real-life launch simulation for an OpenRocket design. OpenRocket (in this
// page, without its windows) prepares the rocket; NOAA's GFS forecast gives the winds for the site
// and time; the flight engine flies it hundreds of times with the uncertain things varied; the map
// shows the flight and where it is likely to land.
import './style.css';
import { base44, currentUser, db } from './base44.js';
import { $, h, avatar, icon, toast, modal, confirmDialog, promptDialog, timeAgo } from './common.js';
import { fetchDesign, openInOpenRocket } from './flight/openrocket.js';
import { environment, fly } from './flight/engine.js';
import { DEFAULT_SPREAD, ensembleWinds, groundFunction, landingStats, runStudy, variations } from './flight/montecarlo.js';
import { deleteFlight, listFlights, openFlight, saveFlight } from './flight/saved.js';
import { elevation, groundGrid } from './flight/terrain.js';
import { createMap } from './flight/map.js';

const params = new URLSearchParams(location.search);
const deg = Math.PI / 180;
const spread = { ...DEFAULT_SPREAD };
let opened = null; // the design open in OpenRocket: { id, simulations, tables(i) }
let tables = null;
let mapReady = null;
let busy = false;
let me = null;

// ------------------------------------------------------------------ formatting

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (bearing) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
const bearingOf = (east, north) => ((Math.atan2(east, north) / deg) + 360) % 360;
const dist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
const speed = (v) => `${v.toFixed(1)} m/s`;

function status(text, kind = '') {
  const el = $('#rocket-status');
  el.className = `plan-status ${kind}`;
  el.replaceChildren(...(Array.isArray(text) ? text : [text]).filter(Boolean).map((t) => (typeof t === 'string' ? h('div', {}, t) : t)));
}

function progress(text, fraction = null) {
  $('#progress').hidden = !text;
  $('#progress-text').textContent = text ?? '';
  $('#progress .bar').style.setProperty('--done', fraction === null ? '100%' : `${Math.round(fraction * 100)}%`);
  $('#progress').classList.toggle('busy', fraction === null);
}

function updateRunButton() {
  $('#run').disabled = busy || !tables || !!tables.unsupported;
}

// ------------------------------------------------------------------ the rocket

async function chooseDesign(id, simulation = 0) {
  if (!id) return;
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  if (opened && opened.id !== id) {
    // OpenRocket reads custom motors once: a fresh page for another design.
    location.href = url.href;
    return;
  }
  history.replaceState(null, '', url.href);
  tables = null;
  updateRunButton();
  $('#sim').disabled = true;
  status('Opening the design in OpenRocket… The first time takes up to half a minute.', 'busy');
  try {
    const design = await fetchDesign(id);
    opened = { id, ...(await openInOpenRocket(id, design)) };
    const sims = opened.simulations;
    if (!sims.length) {
      status('This design has no simulations. Add one in OpenRocket (Flight simulations tab), then come back.', 'warn');
      return;
    }
    $('#sim').replaceChildren(...sims.map((s, i) => h('option', { value: i }, `${s.name} — ${s.configuration || 'no motor'}`)));
    $('#sim').disabled = false;
    const index = simulation < sims.length ? simulation : 0;
    $('#sim').value = String(index);
    await chooseSimulation(index);
  } catch (e) {
    status(e.message, 'error');
  }
}

async function chooseSimulation(index) {
  tables = null;
  updateRunButton();
  status('Preparing the flight in OpenRocket…', 'busy');
  try {
    tables = await opened.tables(Number(index));
  } catch (e) {
    status(e.message, 'error');
    return;
  }
  const l = tables.launch;
  if (!$('#lat').value || !$('#lon').value) setSite(l.latitude, l.longitude);
  $('#rail').value = +l.rodLength.toFixed(2);
  $('#rail-angle').value = Math.round(l.rodAngle / deg);
  $('#rail-dir').value = Math.round(l.rodDirection / deg);
  updateLaunch();
  const or = tables.openrocket;
  const lines = [h('div', {}, h('b', {}, tables.configuration || 'No motor'), ` · OpenRocket's own simulation: apogee ${Math.round(or.apogee)} m, top speed ${speed(or.maxVelocity)}`)];
  if (tables.unsupported) lines.push(h('div', { class: 'warn' }, tables.unsupported));
  if (tables.approximate) lines.push(h('div', { class: 'warn' }, tables.approximate));
  if (tables.extensions) lines.push(h('div', { class: 'warn' }, `This simulation uses extensions (${tables.extensions}), which the planner does not run.`));
  status(lines);
  updateRunButton();
}

// ------------------------------------------------------------------ the site

function setSite(lat, lon, { fromMap = false } = {}) {
  $('#lat').value = (+lat).toFixed(5);
  $('#lon').value = (+lon).toFixed(5);
  mapReady?.then((m) => {
    m.setSite(+lat, +lon, { fly: !fromMap });
    updateLaunch();
  });
}

const railLabel = (angle, direction) => (angle < 0.2 * deg ? 'Vertical launch'
  : `Launch toward ${compass(direction / deg)} (${Math.round((((direction / deg) % 360) + 360) % 360)}°), tilted ${Math.round(angle / deg)}°`);

/** The launch marker from the form (into the wind: from the study on show at this site, if any). */
function updateLaunch() {
  const angle = Math.max(0, Number($('#rail-angle').value) || 0) * deg;
  let direction = (Number($('#rail-dir').value) || 0) * deg;
  let pending = false;
  if ($('#into-wind').checked) {
    const same = current && Math.abs(current.site.lat - Number($('#lat').value)) < 1e-4 && Math.abs(current.site.lon - Number($('#lon').value)) < 1e-4;
    if (same) direction = current.rail.direction;
    else pending = true;
  }
  const label = angle < 0.2 * deg ? 'Vertical launch'
    : pending ? `Rail tilted ${Math.round(angle / deg)}° into the wind (set from the forecast)` : railLabel(angle, direction);
  mapReady?.then((m) => m.setLaunch({ angle, direction, label, pending }));
}

function siteFromInputs() {
  const lat = Number($('#lat').value);
  const lon = Number($('#lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89 || Math.abs(lon) > 180) throw new Error('Enter the launch site’s latitude and longitude.');
  return [lat, lon];
}

/** The spread inputs from `spread`; the wind's are the ensemble's own in ensemble mode. */
function fillSpread() {
  const ensemble = windMode() === 'ensemble';
  for (const input of document.querySelectorAll('[data-spread]')) {
    const scale = Number(input.dataset.scale ?? 1);
    input.value = +(spread[input.dataset.spread] * scale).toFixed(2);
    if (input.dataset.wind !== undefined) input.disabled = ensemble;
  }
  $('#wind-spread-note').hidden = !ensemble;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// ------------------------------------------------------------------ the study

const windMode = () => document.querySelector('input[name="wind-mode"]:checked')?.value ?? 'ensemble';
let current = null; // the study on show: { ...settings, wind, ensemble, nominal, results }

async function run() {
  if (busy || !tables) return;
  busy = true;
  updateRunButton();
  $('#results').hidden = true;
  try {
    const [lat, lon] = siteFromInputs();
    const when = new Date($('#when').value);
    if (Number.isNaN(when.getTime())) throw new Error('Choose a launch time.');
    if (when.getTime() < Date.now() - 3600e3) throw new Error('Choose a launch time from now on: forecasts are for the future.');
    const n = Number($('#runs').value);
    let mode = windMode();
    const notes = [];

    progress(mode === 'ensemble' ? 'Getting the forecast winds (NOAA GFS and its 31-run ensemble)…' : 'Getting the forecast winds (NOAA GFS)…');
    let wind;
    try {
      wind = (await base44.functions.invoke('gfsWinds', { lat, lon, time: when.toISOString(), ensemble: mode === 'ensemble' })).data;
    } catch (e) {
      throw new Error(e.response?.data?.error ?? 'Could not get the forecast. Try again in a moment.');
    }
    if (wind?.error) throw new Error(wind.error);
    let windSets = [];
    if (mode === 'ensemble') {
      if (wind.ensemble?.members?.length) {
        windSets = ensembleWinds(wind.levels, wind.ensemble.members);
      } else {
        mode = 'spread';
        notes.push(`The ensemble forecast was not available (${wind.ensemble?.error ?? 'no answer'}), so this study used the forecast with a fixed spread.`);
      }
    }

    progress('Reading the ground around the site…');
    const siteHeight = await elevation(lat, lon).catch(() => 0);
    const ground0 = wind.levels[0];
    const intoWind = $('#into-wind').checked;
    const rail = {
      angle: Math.max(0, Number($('#rail-angle').value) || 0) * deg,
      direction: intoWind ? Math.atan2(-ground0.u, -ground0.v) : (Number($('#rail-dir').value) || 0) * deg,
      length: Math.max(0, Number($('#rail').value) || 0),
    };
    const conditions = variations(n, spread, rail, 1, { windSets: windSets.length });
    const base = { rodLength: rail.length, coriolis: true };
    // A first flight on flat ground sizes the area of ground to read.
    const flat = fly(tables, environment({ wind: wind.levels, latitude: lat, altitude: siteHeight }), { ...conditions[0], ...base });
    const reach = Math.max(Math.hypot(flat.landingEast, flat.landingNorth), Math.hypot(flat.apogeeEast, flat.apogeeNorth));
    const grid = await groundGrid(lat, lon, Math.min(40000, Math.max(2000, reach * 2.5 + 1500))).catch(() => null);
    const altitude = grid?.site ?? siteHeight;
    const env = environment({ wind: wind.levels, latitude: lat, altitude });
    const nominal = fly(tables, env, { ...conditions[0], ...base, ground: groundFunction(grid), path: 0.1 });

    progress(`Flying ${n} flights…`, 0);
    const setup = { tables, levels: wind.levels, windSets, air: null, latitude: lat, altitude, ground: grid, coriolis: true };
    const conds = conditions.map((c) => ({ ...c, rodLength: rail.length }));
    const results = await runStudy(setup, conds, { onProgress: (d, total) => progress(`Flying ${total} flights… ${d} done`, d / total) });
    progress(null);

    const sim = opened.simulations[Number($('#sim').value)] ?? {};
    const { ensemble: rawEnsemble, levels, ...forecast } = wind;
    current = {
      design: { id: opened.id, name: $('#design').selectedOptions[0]?.textContent ?? '' },
      simulation: { index: Number($('#sim').value), name: sim.name, configuration: tables.configuration },
      site: { lat, lon, altitude },
      when: when.toISOString(),
      rail,
      mode,
      spread: { ...spread },
      n,
      wind: { ...forecast, levels },
      ensemble: windSets.length ? {
        model: rawEnsemble.model, run: rawEnsemble.run, valid: rawEnsemble.valid, count: windSets.length,
        // How far the members' winds spread at each of the forecast's heights (m/s).
        range: levels.map((_, k) => {
          const speeds = windSets.map((w) => Math.hypot(w[k].u, w[k].v));
          return [Math.min(...speeds), Math.max(...speeds)];
        }),
      } : null,
      notes,
      nominal: { path: nominal.path, apogee: nominal.apogee, apogeeEast: nominal.apogeeEast, apogeeNorth: nominal.apogeeNorth, landingEast: nominal.landingEast,
        landingNorth: nominal.landingNorth, flightTime: nominal.flightTime, maxVelocity: nominal.maxVelocity, groundHitVelocity: nominal.groundHitVelocity },
      results,
    };
    await show(current, { saved: null });
  } catch (e) {
    progress(null);
    toast(e.message);
  } finally {
    busy = false;
    updateRunButton();
  }
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'note' }, note) : null);
}

/** One line about where a study's flights land, for the results and saved flights' lists. */
function headline(study, stats) {
  const e95 = stats.ellipses.find((e) => e.p === 0.95);
  return `95% of ${stats.count} flights land inside ${dist(2 * e95.a)} by ${dist(2 * e95.b)}, centred ${dist(Math.hypot(...stats.mean))} ${compass(bearingOf(...stats.mean))} of the pad; apogee ${Math.round(study.nominal.apogee)} m.`;
}

/** Shows a study (just flown, or `saved`: the SavedFlight record it was opened from). */
async function show(study, { saved }) {
  const { nominal, results, wind, ensemble, rail } = study;
  const stats = landingStats(results);
  const e95 = stats.ellipses.find((e) => e.p === 0.95);
  const centre = Math.hypot(...stats.mean);
  const landedFar = results.filter((r) => r && r.landed === false).length;
  const lost = results.filter((r) => !r).length;
  const when = new Date(study.when);
  const lines = [];
  if (saved) {
    lines.push(h('div', { class: 'saved-note' }, h('b', {}, saved.name),
      h('span', { class: 'hint' }, ` · saved ${new Date(saved.created_date).toLocaleString()}. These are the results as saved; run it again for the latest forecast.`)));
  }
  lines.push(
    h('h3', {}, 'Where it lands'),
    h('p', { class: 'headline' },
      `95% of ${stats.count} flights land inside the orange ellipse, ${dist(2 * e95.a)} by ${dist(2 * e95.b)}, centred ${dist(centre)} ${compass(bearingOf(...stats.mean))} of the pad.`),
    h('div', { class: 'stats' },
      stat('Apogee', `${Math.round(nominal.apogee)} m`, `${Math.round(stats.apogee.p5)}–${Math.round(stats.apogee.p95)} m in 90% of flights`),
      stat('Landing (forecast as is)', dist(Math.hypot(nominal.landingEast, nominal.landingNorth)), compass(bearingOf(nominal.landingEast, nominal.landingNorth))),
      stat('Farthest landing', dist(stats.farthest)),
      stat('Flight time', `${Math.round(nominal.flightTime)} s`, `${Math.round(stats.flightTime.p5)}–${Math.round(stats.flightTime.p95)} s`),
      stat('Top speed', speed(nominal.maxVelocity)),
      stat('Landing speed', speed(nominal.groundHitVelocity))),
  );
  for (const note of study.notes ?? []) lines.push(h('p', { class: 'warn' }, note));
  if (landedFar) lines.push(h('p', { class: 'warn' }, `${landedFar} flights were still in the air after 20 minutes and are left out.`));
  if (lost) lines.push(h('p', { class: 'warn' }, `${lost} flights took too long to compute and are left out.`));
  if (!saved) {
    const save = h('button', { class: 'wide' }, 'Save this flight');
    save.onclick = () => saveCurrent(stats);
    lines.push(save);
  }

  // The winds the rocket flies through, with the ensemble's spread at each height.
  const top = Math.max(300, nominal.apogee * 1.15);
  const rows = [];
  for (const [k, l] of wind.levels.entries()) {
    if (l.agl > top && rows.length > 3) break;
    const range = ensemble?.range?.[k];
    rows.push(h('tr', {}, h('td', {}, `${Math.round(l.agl)} m`), h('td', {}, speed(Math.hypot(l.u, l.v))),
      ensemble ? h('td', {}, range ? `${range[0].toFixed(1)}–${range[1].toFixed(1)}` : '') : null,
      h('td', {}, `${compass(bearingOf(-l.u, -l.v))} (${Math.round(bearingOf(-l.u, -l.v))}°)`)));
  }
  const runTime = (iso) => `${new Date(iso).toUTCString().slice(5, 22)} UTC`;
  const how = ensemble
    ? `Wind: NOAA GEFS ensemble (${ensemble.count} forecasts, run of ${runTime(ensemble.run)}) on NOAA GFS (run of ${runTime(wind.run)}); each flight flew in one of the forecasts.`
    : `Wind: NOAA GFS (run of ${runTime(wind.run)}), speed varied by ${Math.round(study.spread.windSpeed * 100)}% and direction by ${Math.round(study.spread.windDirection)}° (one standard deviation).`;
  lines.push(
    h('h3', {}, 'Forecast winds'),
    h('p', { class: 'hint' }, `${how} For ${when.toLocaleString()}. Heights above the ground; wind from.`),
    h('table', { class: 'winds' }, h('thead', {}, h('tr', {}, h('th', {}, 'Height'), h('th', {}, 'Speed'), ensemble ? h('th', {}, 'Ensemble range') : null, h('th', {}, 'From'))),
      h('tbody', {}, rows)),
    h('p', { class: 'hint' }, `${study.design.name} · ${study.simulation.name ?? 'simulation'} (${study.simulation.configuration ?? ''}). Launch site ${Math.round(study.site.altitude)} m above sea level; rail ${rail.length} m, tilted ${Math.round(rail.angle / deg)}° toward ${Math.round(rail.direction / deg)}°.`),
  );
  $('#results').replaceChildren(...lines);
  $('#results').hidden = false;
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const m = await mapReady;
  m.setSite(study.site.lat, study.site.lon, { fly: false });
  m.setLaunch({ angle: rail.angle, direction: rail.direction, label: railLabel(rail.angle, rail.direction), pending: false });
  m.showStudy({ nominal, results, stats });
  $('#replay').hidden = !nominal.path?.length;
}

// ------------------------------------------------------------------ saved flights

async function saveCurrent(stats) {
  if (!current) return;
  const when = new Date(current.when);
  const name = await promptDialog('Save this flight', 'Name', `${current.design.name} · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'Save');
  if (!name) return;
  try {
    const record = await saveFlight(name, current, headline(current, stats), me);
    toast('Saved. Open it any time from Saved flights.');
    const url = new URL(location.href);
    url.searchParams.set('flight', record.id);
    history.replaceState(null, '', url.href);
  } catch (e) {
    toast(`Could not save the flight: ${e.message}`);
  }
}

async function openSaved(recordOrId) {
  try {
    const { record, study } = await openFlight(recordOrId);
    current = study;
    // The form as it was, to run it again with the latest forecast.
    $('#lat').value = study.site.lat.toFixed(5);
    $('#lon').value = study.site.lon.toFixed(5);
    $('#when').value = localInput(new Date(study.when));
    $('#runs').value = String(study.n);
    $('#rail').value = study.rail.length;
    $('#rail-angle').value = Math.round(study.rail.angle / deg);
    $('#rail-dir').value = Math.round((((study.rail.direction / deg) % 360) + 360) % 360);
    const radio = document.querySelector(`input[name="wind-mode"][value="${study.mode}"]`);
    if (radio) radio.checked = true;
    Object.assign(spread, study.spread);
    fillSpread();
    const url = new URL(location.href);
    url.searchParams.set('flight', record.id);
    url.searchParams.set('id', study.design.id);
    history.replaceState(null, '', url.href);
    await show(study, { saved: record });
    // OpenRocket opens the design in the background, so the flight can be run again.
    if (study.design.id && $('#design').value !== study.design.id) {
      $('#design').value = study.design.id;
      chooseDesign(study.design.id, study.simulation.index);
    }
  } catch (e) {
    toast(e.message);
  }
}

async function savedDialog() {
  const list = h('div', { class: 'list saved-list' }, h('div', { class: 'item sub' }, 'Loading…'));
  const close = h('button', {}, 'Close');
  const dlg = modal('Saved flights', [h('p', { class: 'hint', style: 'margin:0' }, 'Flights you saved, with their results as they were. Only you see them.'), list], [close]);
  close.onclick = dlg.close;
  try {
    const flights = await listFlights();
    list.replaceChildren(...(flights.length ? flights.map((f) => {
      const open = h('button', {}, 'Open');
      const del = h('button', { class: 'ghost icon', title: 'Delete', 'aria-label': `Delete ${f.name}` }, icon('trash'));
      open.onclick = () => {
        dlg.close();
        openSaved(f);
      };
      del.onclick = async () => {
        if (!(await confirmDialog('Delete saved flight?', `“${f.name}” will be deleted. This cannot be undone.`, 'Delete', true))) return;
        await deleteFlight(f.id).catch((e) => toast(e.message));
        dlg.close();
        savedDialog();
      };
      return h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', {}, h('b', {}, f.name)),
          h('div', { class: 'sub' }, `${f.design_name ?? ''} · launch ${f.launch_time ? new Date(f.launch_time).toLocaleString() : ''} · saved ${timeAgo(f.created_date)}`),
          f.summary ? h('div', { class: 'sub' }, f.summary) : null),
        open, del);
    }) : [h('div', { class: 'item sub' }, 'No saved flights yet. Run a simulation, then press Save this flight.')]));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'item sub' }, e.message));
  }
}

// ------------------------------------------------------------------ start

async function main() {
  me = await currentUser();
  if (!me) {
    $('#signed-out').hidden = false;
    return;
  }
  $('#me').replaceChildren(avatar(me), h('span', { class: 'name' }, me.name));
  $('#me').hidden = false;
  $('#planner').hidden = false;

  mapReady = createMap($('#map'), { arcgisKey: import.meta.env.VITE_ARCGIS_API_KEY });
  mapReady.then((m) => m.onPick((lat, lon) => setSite(lat, lon, { fromMap: true }))).catch((e) => toast(e.message));

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
  $('#when').value = localInput(next);
  $('#when').min = localInput(new Date(now.getTime() - 3600e3));
  $('#when').max = localInput(new Date(now.getTime() + 16 * 86400e3));
  fillSpread();
  for (const input of document.querySelectorAll('[data-spread]')) {
    const k = input.dataset.spread;
    const scale = Number(input.dataset.scale ?? 1);
    input.onchange = () => (spread[k] = Math.max(0, Number(input.value) || 0) / scale);
  }
  for (const radio of document.querySelectorAll('input[name="wind-mode"]')) radio.onchange = fillSpread;
  $('#saved-btn').onclick = savedDialog;
  $('#into-wind').onchange = () => {
    $('#rail-dir-row').hidden = $('#into-wind').checked;
    updateLaunch();
  };
  $('#rail-angle').onchange = updateLaunch;
  $('#rail-dir').onchange = updateLaunch;
  for (const id of ['#lat', '#lon']) {
    $(id).onchange = () => {
      try {
        setSite(...siteFromInputs());
      } catch {
        // wait for both
      }
    };
  }
  $('#locate').onclick = () => {
    if (!navigator.geolocation) return toast('This browser cannot tell where you are.');
    navigator.geolocation.getCurrentPosition((p) => setSite(p.coords.latitude, p.coords.longitude), () => toast('Could not get your location.'));
  };
  $('#design').onchange = () => chooseDesign($('#design').value);
  $('#sim').onchange = () => chooseSimulation($('#sim').value);
  $('#run').onclick = run;
  $('#replay').onclick = () => mapReady.then((m) => m.replay(1));

  try {
    const designs = (await db.Design.list('-updated_date', 500)).sort((a, b) => a.name.localeCompare(b.name));
    $('#design').replaceChildren(h('option', { value: '' }, designs.length ? 'Choose a design' : 'No designs yet'),
      ...designs.map((d) => h('option', { value: d.id }, d.owner_email === me.email ? d.name : `${d.name} (${d.owner_name ?? d.owner_email})`)));
    const id = params.get('id');
    if (params.get('flight')) {
      if (id) $('#design').value = id;
      openSaved(params.get('flight'));
    } else if (id) {
      $('#design').value = id;
      if ($('#design').value !== id) $('#design').append(h('option', { value: id, selected: true }, 'This design'));
      chooseDesign(id);
    }
  } catch (e) {
    toast(e.message);
  }
}

main().catch((e) => toast(e.message));
