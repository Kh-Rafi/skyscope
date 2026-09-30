const API = '/api';

const DEFAULT_CENTER = [23.68, 90.35];
const DEFAULT_ZOOM = 6;

let map = null;
let airportLayer = null;
let planeLayer = null;
let airportMarkers = [];
let planeMarkers = [];
let currentBounds = null;

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true
  }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  airportLayer = L.layerGroup().addTo(map);
  planeLayer = L.layerGroup().addTo(map);

  return map;
}

function drawAirports(airports) {
  if (!airportLayer) return;

  airportLayer.clearLayers();
  airportMarkers = [];

  airports.forEach(a => {
    let color = '#8a8478';
    let radius = 5;

    if (a.type === 'large_airport') { color = '#1a1a1a'; radius = 8; }
    else if (a.type === 'medium_airport') { color = '#ffb997'; radius = 6; }
    else if (a.type === 'small_airport') { color = '#f59b73'; radius = 4; }

    const marker = L.circleMarker([a.latitude_deg, a.longitude_deg], {
      radius: radius,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 1.5
    });

    marker.bindPopup(`
      <div style="font-size: 13px; line-height: 1.5;">
        <b>🏢 ${a.name}</b><br>
        <span style="color: #8a8478;">${a.municipality || 'Unknown city'}</span><br>
        <b>IATA:</b> ${a.iata_code || 'N/A'}<br>
        <b>Type:</b> ${(a.type || '').replace(/_/g, ' ')}
      </div>
    `);

    marker.addTo(airportLayer);
    airportMarkers.push({ marker, data: a });
  });

  updateStatusAirports(airports.length);
}

function drawPlanes(planes) {
  if (!planeLayer) return;

  // Ensure planes is always a valid array
  if (!Array.isArray(planes)) planes = [];

  planeLayer.clearLayers();
  planeMarkers = [];

  // ---- Update counter FIRST so it can never be out of sync ----
  updateStatusPlanes(planes.length);

  planes.forEach(p => {
    try {
      const color = p.on_ground ? '#43a047' : '#e53935';
      const heading = Number(p.heading) || 0;
      const altitude = Number(p.altitude) || 0;
      const velocity = Number(p.velocity) || 0;
      const lat = Number(p.latitude);
      const lon = Number(p.longitude);

      // Skip if coordinates are invalid
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const icon = L.divIcon({
        className: 'plane-icon',
        html: `
          <div style="
            transform: rotate(${heading}deg);
            font-size: 18px;
            color: ${color};
            text-shadow: 0 0 3px white;
            line-height: 1;
            transition: transform 0.5s ease;
          ">✈️</div>
        `,
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });

      const marker = L.marker([lat, lon], { icon });

      const status = p.on_ground ? '🟢 On Ground' : '🔴 In Flight';
      const callsign = p.callsign || 'Unknown';
      const country = p.origin_country || 'Unknown';

      marker.bindPopup(`
        <div style="font-size: 13px; line-height: 1.6;">
          <b>✈️ ${callsign}</b><br>
          <b>Status:</b> ${status}<br>
          <b>Country:</b> ${country}<br>
          <b>Altitude:</b> ${altitude.toLocaleString()} m<br>
          <b>Speed:</b> ${velocity} km/h<br>
          <b>Heading:</b> ${heading}°
        </div>
      `);

      marker.addTo(planeLayer);
      planeMarkers.push(marker);
    } catch (err) {
      console.warn('Skipping plane due to error:', p && p.callsign, err.message);
    }
  });
}

function fitToBounds(code) {
  if (!map) return;

  let bounds = COUNTRY_BOUNDS[code];

  if (!bounds && typeof allCountries !== 'undefined') {
    const country = allCountries.find(c => c.cca2 === code);
    if (country && country.latlng && country.latlng.length === 2) {
      const [lat, lng] = country.latlng;
      const area = country.area || 100000;
      const sizeDeg = Math.max(1.5, Math.sqrt(area) / 100);
      bounds = [lat - sizeDeg, lat + sizeDeg, lng - sizeDeg, lng + sizeDeg];
    }
  }

  if (!bounds) {
    bounds = [-60, 75, -180, 180];
  }

  const [lamin, lamax, lomin, lomax] = bounds;
  map.fitBounds([[lamin, lomin], [lamax, lomax]], { padding: [20, 20] });
}

function flyTo(lat, lng, zoom = 12) {
  if (!map) return;
  map.flyTo([lat, lng], zoom, { duration: 1.5 });
}

const COUNTRY_BOUNDS = {
  BD: [20.5, 26.7, 88.0, 92.7],
  IN: [6.5, 35.5, 68.0, 97.5],
  PK: [23.5, 37.0, 60.5, 77.5],
  NP: [26.3, 30.5, 80.0, 88.2],
  LK: [5.9, 9.9, 79.6, 81.9],
  CN: [18.0, 53.5, 73.5, 134.8],
  JP: [24.0, 45.5, 122.9, 145.8],
  TH: [5.6, 20.5, 97.3, 105.6],
  MY: [0.8, 7.4, 99.6, 119.3],
  SG: [1.1, 1.5, 103.6, 104.1],
  ID: [-11.0, 6.1, 95.0, 141.0],
  AE: [22.6, 26.1, 51.5, 56.4],
  SA: [16.3, 32.2, 34.5, 55.7],
  QA: [24.5, 26.2, 50.7, 51.7],
  US: [24.5, 49.4, -125.0, -66.9],
  CA: [41.6, 83.1, -141.0, -52.6],
  MX: [14.5, 32.7, -118.4, -86.7],
  BR: [-33.8, 5.3, -73.9, -34.8],
  GB: [49.9, 60.9, -8.7, 1.8],
  FR: [41.3, 51.1, -5.2, 9.6],
  DE: [47.2, 55.1, 5.8, 15.1],
  IT: [36.6, 47.1, 6.6, 18.5],
  ES: [35.9, 43.8, -9.3, 4.4],
  NL: [50.7, 53.6, 3.3, 7.2],
  SE: [55.3, 69.1, 11.0, 24.2],
  NO: [57.9, 71.2, 4.0, 31.1],
  FI: [59.8, 70.1, 19.5, 31.6],
  PL: [49.0, 54.9, 14.1, 24.2],
  GR: [34.8, 41.8, 19.3, 28.3],
  RU: [41.1, 82.0, 19.6, -169.0],
  TR: [35.8, 42.1, 25.6, 44.8],
  AU: [-44.0, -10.0, 112.9, 153.6],
  NZ: [-47.3, -34.0, 166.4, 178.6],
  EG: [22.0, 31.7, 24.7, 36.9],
  ZA: [-34.9, -22.1, 16.4, 32.9],
  NG: [4.2, 13.9, 2.6, 14.7],
  KE: [-4.7, 5.0, 33.8, 41.9]
};

function updateStatusPlanes(count) {
  const el = document.getElementById('planeCount');
  const el2 = document.getElementById('statusPlanes');
  if (el) el.textContent = count;
  if (el2) el2.textContent = count;
}

function updateStatusAirports(count) {
  const el = document.getElementById('statusAirports');
  if (el) el.textContent = count;
}

function updateStatusUpdated() {
  const el = document.getElementById('statusUpdated');
  if (el) {
    const t = new Date().toLocaleTimeString();
    el.textContent = `Updated ${t}`;
  }
}

function updateStatusCountry(name) {
  const el = document.getElementById('statusCountry');
  if (el) el.textContent = name;
}

function addMapLegend() {
  if (!map) return;

  const legend = L.control({ position: 'bottomleft' });

  legend.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <strong>🗺️ Legend</strong>

      <div class="legend-section">
        <div class="legend-row">
          <span class="legend-plane" style="color:#e53935;">✈️</span>
          <span>Flying plane</span>
        </div>
        <div class="legend-row">
          <span class="legend-plane" style="color:#43a047;">✈️</span>
          <span>On-ground plane</span>
        </div>
      </div>

      <div class="legend-section">
        <div class="legend-row">
          <span class="legend-dot" style="background:#1a1a1a;"></span>
          <span>Large airport</span>
        </div>
        <div class="legend-row">
          <span class="legend-dot" style="background:#ffb997;"></span>
          <span>Medium airport</span>
        </div>
        <div class="legend-row">
          <span class="legend-dot" style="background:#f59b73;"></span>
          <span>Small airport</span>
        </div>
      </div>
    `;

    L.DomEvent.disableClickPropagation(div);
    return div;
  };

  legend.addTo(map);
}
