/* ==========================================================================
   route.js — Draw a driving route from user's location to a destination airport
   Uses OpenRouteService via our own /api/directions proxy

   Features:
   - Live-updating route as the user moves toward the airport
   - Country restriction (airport must be in the currently selected country)
   - Fixed Done button (closes sheet, keeps route on map)
   - Clear Route button (removes everything from map)
   ========================================================================== */

let routeLine = null;         // Leaflet polyline
let routeStartMarker = null;  // "You are here" marker
let routeEndMarker = null;    // destination marker
let currentRoute = null;      // last fetched route data
let lastDirectionsCall = 0;   // cooldown tracking

// Live-tracking state
let currentAirport = null;    // airport the user is navigating to
let currentWatchId = null;    // geolocation watchPosition ID
let lastRouteFetchPos = null; // last position at which we fetched a route
const ROUTE_REFRESH_METERS = 500; // re-fetch route every 500m of movement

const DIRECTIONS_COOLDOWN_MS = 3000;

// ---------- Public: called from airport popup ----------
async function getDirectionsTo(airport) {
  if (!airport || airport.latitude_deg == null || airport.longitude_deg == null) {
    showToast('Airport location unknown', 'warning');
    return;
  }

  // Enforce country restriction — airport must be in currently selected country
  if (airport.iso_country && currentCountry && airport.iso_country !== currentCountry) {
    showToast(
      `✈️ Directions only available within ${currentCountry}. Switch country to ${airport.iso_country} first.`,
      'warning',
      6000
    );
    return;
  }

  // Cooldown — prevent spam clicking
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

    // Start live tracking so distance updates as user moves
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

// ---------- Internal: live tracking while user drives ----------
function startLiveTracking(airport) {
  if (!navigator.geolocation) return;

  currentWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;

      // Skip if no airport is being tracked
      if (!currentAirport) return;

      // Check how far we've moved since last fetch
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
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000
    }
  );
}

function stopLiveTracking() {
  if (currentWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(currentWatchId);
    currentWatchId = null;
  }
}

// Distance between two lat/lon points in meters (Haversine)
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

  // Remove old line + markers, but keep currentAirport / tracking intact
  if (routeLine && map) { map.removeLayer(routeLine); routeLine = null; }
  if (routeStartMarker && map) { map.removeLayer(routeStartMarker); routeStartMarker = null; }
  if (routeEndMarker && map) { map.removeLayer(routeEndMarker); routeEndMarker = null; }

  // "You are here" blue marker
  routeStartMarker = L.circleMarker([from.lat, from.lon], {
    radius: 9,
    color: '#1e88e5',
    fillColor: '#1e88e5',
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
  routeStartMarker.bindPopup('<b>📍 You are here</b>');

  // Destination marker (red pin)
  routeEndMarker = L.circleMarker([to.lat, to.lon], {
    radius: 9,
    color: '#e53935',
    fillColor: '#e53935',
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
  routeEndMarker.bindPopup(`<b>🛬 ${airportName}</b>`);

  // Route line — Leaflet accepts GeoJSON directly
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

  // Zoom map to fit both markers + route
  const group = L.featureGroup([routeStartMarker, routeEndMarker, routeLine]);
  map.fitBounds(group.getBounds(), { padding: [60, 60] });
}

// ---------- Bottom sheet / side panel ----------
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

  // Header
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

  // Body
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

  // ---- Wire up buttons safely ----
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
      // Done = close the sheet but keep route + live tracking active
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

// ---------- Delegated: close sheet when backdrop is clicked ----------
document.addEventListener('click', (e) => {
  if (e.target.id === 'routeBackdrop') closeRouteSheet();
});

// ---------- Fallback escapeHtml (in case app.js hasn't loaded yet) ----------
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
