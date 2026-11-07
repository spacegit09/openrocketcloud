// The launch planner's map: CesiumJS (Apache-2.0, loaded from a CDN) with Esri World Imagery
// satellite pictures (ArcGIS Location Platform, pay as you go above its free monthly tiles). No
// Cesium ion services are used. Heights are drawn above the launch site's ground on a smooth Earth,
// which is how the flight engine measures them.
import { ellipsePoints } from './montecarlo.js';
import { offset } from './terrain.js';

const CESIUM = 'https://cdn.jsdelivr.net/npm/cesium@1.146.0/Build/Cesium/';
let loading = null;

function loadCesium() {
  loading ??= new Promise((resolve, reject) => {
    window.CESIUM_BASE_URL = CESIUM;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${CESIUM}Widgets/widgets.css`;
    document.head.append(css);
    const s = document.createElement('script');
    s.src = `${CESIUM}Cesium.js`;
    s.onload = () => resolve(window.Cesium);
    s.onerror = () => reject(new Error('Could not load the map. Check your connection and reload.'));
    document.head.append(s);
  });
  return loading;
}

/**
 * A map in `el`: { setSite(lat, lon), onPick(fn(lat, lon)), setLaunch(rail), showStudy(study), replay(), clear() }.
 * `arcgisKey` is the site's ArcGIS API key (Cesium's evaluation key is used without one).
 */
export async function createMap(el, { arcgisKey } = {}) {
  const Cesium = await loadCesium();
  if (arcgisKey) Cesium.ArcGisMapService.defaultAccessToken = arcgisKey;
  const viewer = new Cesium.Viewer(el, {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(Cesium.ArcGisMapServerImageryProvider.fromBasemapType(Cesium.ArcGisBaseMapType.SATELLITE)),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: true,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
  });
  if (import.meta.env.DEV) window.plannerViewer = viewer; // for local checks
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere.show = true;
  const { Cartesian3, Color, HeightReference } = Cesium;

  let site = null;
  let pad = null;
  // The launch marker: the rail (drawn longer than it is, to be seen) and an arrow on the ground the
  // way it leans, sized to the view (m).
  let launch = null;
  let launchMarks = [];
  let launchScale = 80;
  const study = new Cesium.CustomDataSource('study');
  viewer.dataSources.add(study);
  const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  let replayEntity = null;
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  legend.hidden = true;
  el.append(legend);
  const item = (color, text, kind) => {
    const swatch = document.createElement('span');
    swatch.className = `swatch ${kind}`;
    swatch.style.setProperty('--c', color);
    const row = document.createElement('div');
    row.append(swatch, text);
    return row;
  };
  let lastPath = null;
  let pick = null;

  const at = (east, north, up = 0) => {
    const [lat, lon] = offset(site[0], site[1], east, north);
    return Cartesian3.fromDegrees(lon, lat, up);
  };

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((e) => {
    const c = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
    if (!c || !pick) return;
    const g = Cesium.Cartographic.fromCartesian(c);
    pick(Cesium.Math.toDegrees(g.latitude), Cesium.Math.toDegrees(g.longitude));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function drawLaunch() {
    for (const e of launchMarks) viewer.entities.remove(e);
    launchMarks = [];
    if (!site || !launch) return;
    const { angle, direction, label, pending } = launch;
    const tilted = angle > 0.2 * (Math.PI / 180) && !pending;
    const rail = launchScale * 0.45;
    const d = [Math.sin(angle) * Math.sin(direction), Math.sin(angle) * Math.cos(direction), Math.cos(angle)];
    launchMarks.push(viewer.entities.add({
      polyline: { positions: [at(0, 0, 0.5), at(d[0] * rail, d[1] * rail, Math.max(0.5, d[2] * rail))], width: 4, material: Color.WHITE.withAlpha(0.9) },
    }));
    let tip = at(0, 0, rail);
    if (tilted) {
      const e = Math.sin(direction) * launchScale;
      const n = Math.cos(direction) * launchScale;
      tip = at(e * 1.12, n * 1.12, 1);
      launchMarks.push(viewer.entities.add({
        polyline: { positions: [at(0, 0, 1), at(e, n, 1)], width: 16, clampToGround: false,
          material: new Cesium.PolylineArrowMaterialProperty(Color.fromCssColorString('#ff7a2f')) },
      }));
    }
    launchMarks.push(viewer.entities.add({
      position: tip,
      label: { text: label, font: '600 12px system-ui, sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, 18), showBackground: true,
        backgroundColor: Color.fromCssColorString('#0f141e').withAlpha(0.6) },
    }));
  }

  function clear() {
    legend.hidden = true;
    study.entities.removeAll();
    points.removeAll();
    if (replayEntity) viewer.entities.remove(replayEntity);
    replayEntity = null;
    lastPath = null;
    viewer.clock.shouldAnimate = false;
  }

  return {
    viewer,
    onPick(fn) {
      pick = fn;
    },
    setSite(lat, lon, { fly = true } = {}) {
      const moved = !site || Math.abs(site[0] - lat) > 1e-9 || Math.abs(site[1] - lon) > 1e-9;
      site = [lat, lon];
      if (moved) clear();
      if (pad) viewer.entities.remove(pad);
      drawLaunch();
      pad = viewer.entities.add({
        position: Cartesian3.fromDegrees(lon, lat, 0),
        point: { pixelSize: 12, color: Color.fromCssColorString('#ff7a2f'), outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.NONE },
        label: { text: 'Launch', font: '600 13px system-ui, sans-serif', pixelOffset: new Cesium.Cartesian2(0, -20), fillColor: Color.WHITE,
          outlineColor: Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE },
      });
      if (fly) {
        viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat - 0.02, 2500), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 }, duration: 1.2 });
      }
    },
    /** Draws a study: { nominal: { path, apogee... }, results, stats } in metres east/north/up of the site. */
    showStudy({ nominal, results, stats }) {
      clear();
      const landing = Color.fromCssColorString('#ffd43b');
      for (const r of results) {
        if (!r || r.landed === false) continue;
        points.add({ position: at(r.landingEast, r.landingNorth, 0.5), pixelSize: 5, color: landing.withAlpha(0.85), outlineColor: Color.BLACK.withAlpha(0.6), outlineWidth: 1 });
      }
      const colors = ['#51cf66', '#ffa94d', '#ff6b6b'];
      for (const [k, e] of stats.ellipses.entries()) {
        const pts = ellipsePoints(stats.mean, e).map(([x, y]) => at(x, y, 1));
        const color = Color.fromCssColorString(colors[k] ?? '#ffffff');
        study.entities.add({ polyline: { positions: pts, width: 2.5, material: color } });
        study.entities.add({ polygon: { hierarchy: pts, material: color.withAlpha(0.08), perPositionHeight: true } });
      }
      legend.replaceChildren(
        ...stats.ellipses.map((e, k) => item(colors[k], `${Math.round(e.p * 100)}% of landings`, 'ring')),
        item('#ffd43b', 'One flight’s landing', 'dot'),
        item('#4dabf7', 'Flight in the forecast as is', 'line'));
      legend.hidden = false;
      if (nominal?.path?.length) {
        lastPath = nominal.path;
        study.entities.add({
          polyline: { positions: nominal.path.map(([, e, n, u]) => at(e, n, Math.max(0, u))), width: 3, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Color.fromCssColorString('#4dabf7') }) },
        });
        study.entities.add({
          position: at(nominal.apogeeEast, nominal.apogeeNorth, nominal.apogee),
          point: { pixelSize: 9, color: Color.fromCssColorString('#4dabf7'), outlineColor: Color.WHITE, outlineWidth: 2 },
          label: { text: `Apogee ${Math.round(nominal.apogee)} m`, font: '600 12px system-ui, sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18) },
        });
      }
      // Everything in view: the pad, the landing area and the top of the flight.
      const all = [at(0, 0, 0), ...results.filter(Boolean).map((r) => at(r.landingEast, r.landingNorth, 0))];
      if (nominal) all.push(at(nominal.apogeeEast, nominal.apogeeNorth, nominal.apogee));
      const sphere = Cesium.BoundingSphere.fromPoints(all);
      launchScale = Math.max(80, Math.min(3000, sphere.radius * 0.5));
      drawLaunch();
      viewer.camera.flyToBoundingSphere(sphere, { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), sphere.radius * 3 + 300), duration: 1.5 });
    },
    /** Replays the nominal flight in real time (or `speed` times faster). */
    replay(speed = 1) {
      if (!lastPath) return;
      if (replayEntity) viewer.entities.remove(replayEntity);
      const start = Cesium.JulianDate.now();
      const position = new Cesium.SampledPositionProperty();
      for (const [t, e, n, u] of lastPath) position.addSample(Cesium.JulianDate.addSeconds(start, t, new Cesium.JulianDate()), at(e, n, Math.max(0, u)));
      const stop = Cesium.JulianDate.addSeconds(start, lastPath[lastPath.length - 1][0], new Cesium.JulianDate());
      replayEntity = viewer.entities.add({
        availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({ start, stop })]),
        position,
        point: { pixelSize: 11, color: Color.WHITE, outlineColor: Color.fromCssColorString('#ff7a2f'), outlineWidth: 3 },
        path: { leadTime: 0, trailTime: 1e6, width: 2, material: Color.WHITE.withAlpha(0.7) },
      });
      viewer.clock.startTime = start.clone();
      viewer.clock.currentTime = start.clone();
      viewer.clock.stopTime = stop.clone();
      viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
      viewer.clock.multiplier = speed;
      viewer.clock.shouldAnimate = true;
      viewer.trackedEntity = undefined;
    },
    clear,
    /**
     * The launch marker: the rail tilted `angle` toward `direction` (rad, clockwise from north),
     * with `label`; `pending` when the direction is not known yet (into the wind, before a forecast).
     */
    setLaunch(next) {
      launch = next;
      drawLaunch();
    },
  };
}
