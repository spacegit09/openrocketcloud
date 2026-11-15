// The logbook's launch site on a map: the Launch Planner's satellite map (flight/map.js) in a
// dialog. Search for a place or use your location to get there, then click where you launched.
// Loaded when the map is first opened (the map itself, CesiumJS, comes from its CDN then).
import { h, icon, modal } from '../common.js';
import { createMap } from '../flight/map.js';
import { formatSite } from './data.js';

const KEY = import.meta.env.VITE_ARCGIS_API_KEY;
// ArcGIS geocoding, with the site's key (it works from the site's own addresses only). A place
// found only moves the map; the site kept is where the person clicks.
const GEOCODE = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';

/** Places matching `text`: [{ name, area: { west, south, east, north } }]. */
async function findPlaces(text) {
  const url = `${GEOCODE}?${new URLSearchParams({ SingleLine: text, f: 'json', maxLocations: '5', token: KEY ?? '' })}`;
  let j;
  try {
    j = await (await fetch(url)).json();
  } catch {
    throw new Error('Place search is not reachable. Check your connection.');
  }
  if (j.error) throw new Error('Place search is not available here.');
  return (j.candidates ?? []).map((c) => {
    const e = c.extent;
    const d = 0.02; // about 2 km, when the place has no extent
    return {
      name: c.address,
      area: e ? { west: e.xmin, south: e.ymin, east: e.xmax, north: e.ymax }
        : { west: c.location.x - d, south: c.location.y - d, east: c.location.x + d, north: c.location.y + d },
    };
  });
}

/**
 * Opens the map at `start` ({ lat, lon }, the site the logbook has, if any). Resolves with the
 * site chosen ({ lat, lon }), or null when the dialog is closed without one.
 */
export function pickSite(start = null) {
  return new Promise((resolve) => {
    const query = h('input', { type: 'search', placeholder: 'Search for a place, e.g. a field or town', 'aria-label': 'Search for a place', enterkeyhint: 'search' });
    const searchBtn = h('button', { type: 'submit' }, 'Search');
    const form = h('form', { class: 'site-pick-search' }, query, searchBtn);
    const results = h('div', { class: 'site-pick-results' });
    const note = h('p', { class: 'site-pick-note' }, 'Loading the map…');
    const mapEl = h('div', { class: 'site-pick-map' }, note);
    const readout = h('span', { class: 'hint' }, 'Click the map where you launched.');
    const mine = h('button', { type: 'button', class: 'ghost link' }, icon('target'), 'Use my location');
    const use = h('button', { class: 'primary', disabled: true }, 'Use this location');
    const cancel = h('button', {}, 'Cancel');
    const { dialog, close } = modal('Launch site', [form, results, mapEl, h('div', { class: 'site-pick-foot' }, readout, mine)], [cancel, use]);
    dialog.classList.add('site-pick-dialog');

    let map = null;
    let area = null; // a place found before the map was ready
    let chosen = null;
    let result = null;
    const choose = (lat, lon, { fly }) => {
      chosen = { lat, lon };
      readout.textContent = `Launch site: ${formatSite(lat, lon)}`;
      use.disabled = false;
      map?.setSite(lat, lon, { fly });
    };
    if (start) choose(start.lat, start.lon, { fly: true });

    createMap(mapEl, { arcgisKey: KEY }).then((m) => {
      if (!dialog.isConnected) return m.viewer.destroy(); // closed while it loaded
      map = m;
      note.remove();
      m.onPick((lat, lon) => choose(lat, lon, { fly: false }));
      if (chosen) m.setSite(chosen.lat, chosen.lon, { fly: !area });
      if (area) m.flyToArea(area);
    }).catch((e) => {
      note.textContent = e.message;
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = query.value.trim();
      if (!text) return;
      searchBtn.disabled = true;
      results.replaceChildren(h('span', { class: 'hint' }, 'Searching…'));
      try {
        const places = await findPlaces(text);
        if (!places.length) {
          results.replaceChildren(h('span', { class: 'hint' }, `Nothing found for “${text}”.`));
        } else {
          const go = (p) => {
            area = p.area;
            map?.flyToArea(p.area);
          };
          results.replaceChildren(...places.map((p) => {
            const b = h('button', { type: 'button', class: 'ghost' }, icon('pin'), p.name);
            b.onclick = () => go(p);
            return b;
          }), h('span', { class: 'hint site-pick-credit' }, 'Places by Esri'));
          go(places[0]);
        }
      } catch (err) {
        results.replaceChildren(h('span', { class: 'error' }, err.message));
      } finally {
        searchBtn.disabled = false;
      }
    };

    mine.onclick = () => {
      if (!navigator.geolocation) {
        readout.textContent = 'This browser cannot tell where you are.';
        return;
      }
      readout.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(
        (p) => choose(p.coords.latitude, p.coords.longitude, { fly: true }),
        () => { readout.textContent = 'Could not get your location. Click the map instead.'; },
        { enableHighAccuracy: true, timeout: 15000 });
    };

    use.onclick = () => {
      result = chosen;
      close();
    };
    cancel.onclick = close;
    dialog.addEventListener('close', () => {
      map?.viewer.destroy();
      resolve(result);
    });
  });
}
