/* ==========================================================================
   route.js — Draw a driving route from user's location to a destination airport
   Uses OpenRouteService via our own /api/directions proxy
   ========================================================================== */

let routeLine = null;         // Leaflet polyline
let routeStartMarker = null;  // "You are here" marker
let routeEndMarker = null;    // destination marker
let currentRoute = null;      // last fetched route data
let lastDirectionsCall = 0;   // cooldown tracking

// Live-tracking state
let currentAirport = null;
let currentWatchId = null;
let lastRouteFetchPos = null;
const ROUTE_REFRESH_METERS = 500;

const DIRECTIONS_COOLDOWN_MS = 3000;

// ---------- Region lookup: what region is each country in? ----------
// Used to block cross-continent routes (you can't drive from Asia to Africa)
const COUNTRY_REGION = {
  // South Asia
  BD: 'Asia', IN: 'Asia', PK: 'Asia', NP: 'Asia', LK: 'Asia', BT: 'Asia',
  AF: 'Asia', MV: 'Asia',
  // East Asia
  CN: 'Asia', JP: 'Asia', KR: 'Asia', KP: 'Asia', TW: 'Asia', HK: 'Asia',
  MO: 'Asia', MN: 'Asia',
  // Southeast Asia
  TH: 'Asia', MM: 'Asia', LA: 'Asia', KH: 'Asia', VN: 'Asia', MY: 'Asia',
  SG: 'Asia', ID: 'Asia', PH: 'Asia', BN: 'Asia', TL: 'Asia',
  // Central Asia
  KZ: 'Asia', UZ: 'Asia', TM: 'Asia', KG: 'Asia', TJ: 'Asia',
  // Middle East
  AE: 'Asia', SA: 'Asia', QA: 'Asia', BH: 'Asia', KW: 'Asia', OM: 'Asia',
  YE: 'Asia', JO: 'Asia', IL: 'Asia', LB: 'Asia', SY: 'Asia', IQ: 'Asia',
  IR: 'Asia', TR: 'Asia', GE: 'Asia', AM: 'Asia', AZ: 'Asia',
  // Europe
  GB: 'Europe', IE: 'Europe', FR: 'Europe', DE: 'Europe', NL: 'Europe',
  BE: 'Europe', LU: 'Europe', ES: 'Europe', PT: 'Europe', IT: 'Europe',
  CH: 'Europe', AT: 'Europe', CZ: 'Europe', SK: 'Europe', HU: 'Europe',
  PL: 'Europe', DK: 'Europe', SE: 'Europe', NO: 'Europe', FI: 'Europe',
  EE: 'Europe', LV: 'Europe', LT: 'Europe', BY: 'Europe', UA: 'Europe',
  MD: 'Europe', RO: 'Europe', BG: 'Europe', GR: 'Europe', AL: 'Europe',
  MK: 'Europe', RS: 'Europe', ME: 'Europe', BA: 'Europe', HR: 'Europe',
  SI: 'Europe', RU: 'Europe', IS: 'Europe',
  // North America
  US: 'North America', CA: 'North America', MX: 'North America',
  CU: 'North America', JM: 'North America', HT: 'North America',
  DO: 'North America', PR: 'North America', BS: 'North America',
  GT: 'North America', BZ: 'North America', SV: 'North America',
  HN: 'North America', NI: 'North America', CR: 'North America',
  PA: 'North America',
  // South America
  BR: 'South America', AR: 'South America', CL: 'South America',
  CO: 'South America', PE: 'South America', VE: 'South America',
  EC: 'South America', BO: 'South America', PY: 'South America',
  UY: 'South America', GY: 'South America', SR: 'South America',
  GF: 'South America',
  // Africa
  DZ: 'Africa', MA: 'Africa', TN: 'Africa', LY: 'Africa', EG: 'Africa',
  SD: 'Africa', SS: 'Africa', ET: 'Africa', ER: 'Africa', DJ: 'Africa',
  SO: 'Africa', KE: 'Africa', UG: 'Africa', TZ: 'Africa', RW: 'Africa',
  BI: 'Africa', CD: 'Africa', CG: 'Africa', CF: 'Africa', CM: 'Africa',
  TD: 'Africa', NE: 'Africa', NG: 'Africa', BJ: 'Africa', TG: 'Africa',
  GH: 'Africa', CI: 'Africa', LR: 'Africa', SL: 'Africa', GN: 'Africa',
  GW: 'Africa', SN: 'Africa', GM: 'Africa', MR: 'Africa', ML: 'Africa',
  BF: 'Africa', ZA: 'Africa', NA: 'Africa', BW: 'Africa', ZW: 'Africa',
  MZ: 'Africa', MW: 'Africa', ZM: 'Africa', AO: 'Africa', MG: 'Africa',
  MU: 'Africa', SC: 'Africa', KM: 'Africa', GA: 'Africa', GQ: 'Africa',
  // Oceania
  AU: 'Oceania', NZ: 'Oceania', PG: 'Oceania', FJ: 'Oceania',
  SB: 'Oceania', VU: 'Oceania', NC: 'Oceania', PF: 'Oceania',
};

// ---------- Public: called from airport popup ----------
async function getDirectionsTo(airport) {
  if (!airport || airport.latitude_deg == null || airport.longitude_deg == null) {
    showToast('Airport location unknown', 'warning');
    return;
  }

  // ---- Country mismatch check (BLOCKING, before anything else) ----
  if (airport.iso_country && currentCountry && airport.iso_country !== currentCountry) {
    const airportCountry = airport.iso_country;
    showToast(
      `✈️ Directions only work within ${currentCountry}. This airport is in ${airportCountry}. Please switch country first.`,
      'warning',
      7000
    );
    return;
  }

  // ---- Cross-continent check (you can't drive from Asia to Africa) ----
  const myRegion = COUNTRY_REGION[currentCountry];
  const theirRegion = COUNTRY_REGION[airport.iso_country];
  if (myRegion && theirRegion && myRegion !== theirRegion) {
    showToast(
      `🌍 No driving route from ${myRegion} to ${theirRegion}. Pick an airport on the same continent.`,
      'warning',
      7000
    );
    return;
  }

  // Cooldown
  const now = Date.now();
  if (now - lastDirectionsCall < DIRECTIONS_COOLDOWN_MS) {
    showToast('Please wait a moment before requesting another route.', 'warning');
    return;
  }
  lastDirectionsCall = now;

  // Stop any previous live tracking
  stopLiveTracking();

  currentAirport = airport;
  currentRoute = null;
  lastRouteFetchPos = null;

  showRouteSheet({
    state: 'loading',
    destination: airport,
    message: 'Finding your location...'
  });

  try {
    const position = await getCurrentPosition();
    const { latitude: fromLat, longitude: fromLon } = position.coords;

    lastRouteFetchPos = { lat: fromLat, lon: fromLon };

    showRouteSheet({
      state: 'loading',
      destination: airport,
      message: 'Calculating route...'
    });

    await fetchAndDrawRoute(fromLat, fromLon, airport);

    startLiveTracking(airport);

  } catch (err) {
    console.warn('[route] error:', err.message);
    showRouteSheet({
      state: 'error',
      destination: airport,
      message: err.message === 'denied'
        ? 'Location access denied. Enable location permissions.'
        : 'Unable to get directions'
    });
  }
}

// ---------- Public: clear the route from map ----------
function clearRoute() {
  stopLiveTracking();

  if (routeLine && map) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (routeStartMarker && map) {
    map.removeLayer(routeStartMarker);
    routeStartMarker = null;
  }
  if (routeEndMarker && map) {
    map.removeLayer(routeEndMarker);
    routeEndMarker = null;
  }
  currentRoute = null;
  currentAirport = null;
  lastRouteFetchPos = null;
}

// ---------- Internal: fetch and draw the route ----------
async function fetchAndDrawRoute(fromLat, fromLon, airport) {
  const url = `/api/directions?fromLat=${fromLat}&fromLon=${fromLon}&toLat=${airport.latitude_deg}&toLon=${airport.longitude_deg}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Could not fetch route');
  }

  currentRoute = data;

  drawRouteOnMap(
    { lat: fromLat, lon: fromLon },
    { lat: airport.latitude_deg, lon: airport.longitude_deg },
    data.geometry,
    airport.name
  );

  showRouteSheet({
    state: 'ready',
    destination: airport,
    distanceKm: data.distanceKm,
    durationMinutes: data.durationMinutes
  });

  return data;
}

// ---------- Internal: live tracking ----------
function startLiveTracking(airport) {
  if (!navigator.geolocation) return;

  currentWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      if (!currentAirport) return;

      if (lastRouteFetchPos) {
        const movedMeters = haversineMeters(
          lastRouteFetchPos.lat,
          lastRouteFetchPos.lon,
          latitude,
          longitude
        );
        if (movedMeters < ROUTE_REFRESH_METERS) return;
      }

      lastRouteFetchPos = { lat: latitude, lon: longitude };

      try {
        await fetchAndDrawRoute(latitude, longitude, currentAirport);
        console.log('[route] live update — route refreshed');
      } catch (err) {
        console.warn('[route] live update failed:', err.message);
      }
    },
    (err) => {
      console.warn('[route] watch error:', err.message);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

function stopLiveTracking() {
  if (currentWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(currentWatchId);
    currentWatchId = null;
  }
}

// Haversine distance
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Internal: geolocation promise ----------
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => reject(new Error(err.code === 1 ? 'denied' : 'unavailable')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// ---------- Internal: draw route on Leaflet map ----------
function drawRouteOnMap(from, to, geometry, airportName) {
  if (!map) return;

  if (routeLine && map) { map.removeLayer(routeLine); routeLine = null; }
  if (routeStartMarker && map) { map.removeLayer(routeStartMarker); routeStartMarker = null; }
  if (routeEndMarker && map) { map.removeLayer(routeEndMarker); routeEndMarker = null; }

  routeStartMarker = L.circleMarker([from.lat, from.lon], {
    radius: 9,
    color: '#1e88e5',
    fillColor: '#1e88e5',
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
  routeStartMarker.bindPopup('<b>📍 You are here</b>');

  routeEndMarker = L.circleMarker([to.lat, to.lon], {
    radius: 9,
    color: '#e53935',
    fillColor: '#e53935',
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
  routeEndMarker.bindPopup(`<b>🛬 ${airportName}</b>`);

  routeLine = L.geoJSON(geometry, {
    style: {
      color: '#1e88e5',
      weight: 5,
      opacity: 0.85,
      dashArray: '10, 8',
      lineCap: 'round',
      lineJoin: 'round'
    }
  }).addTo(map);

  const group = L.featureGroup([routeStartMarker, routeEndMarker, routeLine]);
  map.fitBounds(group.getBounds(), { padding: [60, 60] });
}

// ---------- Bottom sheet ----------
function showRouteSheet(payload) {
  const sheet = document.getElementById('routeSheet');
  if (!sheet) return;

  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');

  const backdrop = document.getElementById('routeBackdrop');
  if (backdrop) backdrop.classList.add('show');

  const header = sheet.querySelector('.route-sheet-header');
  const body = sheet.querySelector('.route-sheet-body');
  const actions = sheet.querySelector('.route-sheet-actions');

  if (payload.destination) {
    header.innerHTML = `
      <div class="route-sheet-handle"></div>
      <button class="route-sheet-close" id="routeSheetX" aria-label="Close">✕</button>
      <div class="route-sheet-title">🛬 ${escapeHtml(payload.destination.name || 'Airport')}</div>
      <div class="route-sheet-subtitle">
        ${escapeHtml(payload.destination.municipality || '')}
        ${payload.destination.iata_code ? ' · ' + payload.destination.iata_code : ''}
        ${payload.destination.iso_country ? ' · ' + payload.destination.iso_country : ''}
      </div>
    `;
  }

  if (payload.state === 'loading') {
    body.innerHTML = `
      <div class="route-loading">
        <div class="route-spinner"></div>
        <span>${escapeHtml(payload.message || 'Loading...')}</span>
      </div>
    `;
    actions.innerHTML = '';
  } else if (payload.state === 'ready') {
    body.innerHTML = `
      <div class="route-stats">
        <div class="route-stat">
          <div class="route-stat-icon">🚗</div>
          <div class="route-stat-value" id="routeDistanceValue">${payload.distanceKm} km</div>
          <div class="route-stat-label">Distance</div>
        </div>
        <div class="route-stat">
          <div class="route-stat-icon">⏱️</div>
          <div class="route-stat-value" id="routeDurationValue">${payload.durationMinutes} min</div>
          <div class="route-stat-label">Est. time</div>
        </div>
      </div>
      <div class="route-live-hint" style="font-size:12px;color:#8a8478;text-align:center;margin-top:10px;">
        🔄 Route updates automatically as you drive
      </div>
    `;
    actions.innerHTML = `
      <button class="route-btn-secondary" id="routeSheetClear" type="button">Clear Route</button>
      <button class="route-btn-primary" id="routeSheetDone" type="button">Done</button>
    `;
  } else if (payload.state === 'error') {
    body.innerHTML = `
      <div class="route-error">
        <div class="route-error-icon">⚠️</div>
        <div>${escapeHtml(payload.message || 'Unable to get directions')}</div>
      </div>
    `;
    actions.innerHTML = `
      <button class="route-btn-primary" id="routeSheetDone" type="button">Close</button>
    `;
  }

  const closeX = document.getElementById('routeSheetX');
  if (closeX) {
    closeX.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRouteSheet();
    });
  }

  const clearBtn = document.getElementById('routeSheetClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearRoute();
      closeRouteSheet();
    });
  }

  const doneBtn = document.getElementById('routeSheetDone');
  if (doneBtn) {
    doneBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRouteSheet();
    });
  }
}

function closeRouteSheet() {
  const sheet = document.getElementById('routeSheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');

  const backdrop = document.getElementById('routeBackdrop');
  if (backdrop) backdrop.classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'routeBackdrop') closeRouteSheet();
});

if (typeof window.escapeHtml !== 'function') {
  window.escapeHtml = function (str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  };
}
