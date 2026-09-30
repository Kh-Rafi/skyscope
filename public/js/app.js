const currentUser = JSON.parse(localStorage.getItem('user') || 'null');
if (!currentUser) {
  window.location.href = 'index.html';
}

const APP_API = '/api';

const MAX_PLANES = 100;
const MAX_AIRPORTS = 150;
const HEAVY_COUNTRIES = ['US', 'CN', 'IN', 'RU', 'BR', 'AU', 'CA', 'MX'];

let currentCountry = 'BD';
let planesInterval = null;

// ---- Request tracking (fixes race conditions) ----
let planesAbortController = null;
let airportsAbortController = null;
let planesRequestId = 0;
let airportsRequestId = 0;

// ---- Client-side cache (instant country switch feel) ----
const planesCache = new Map();   // country -> { planes, timestamp }
const airportsCache = new Map(); // country -> airports
const CACHE_TTL = 60 * 1000;     // 60 seconds

async function initApp() {
  console.log('🚀 Initializing SkyScope...');

  initMap();

  if (typeof addMapLegend === 'function') addMapLegend();

  setTimeout(() => {
    const loader = document.getElementById('mapLoading');
    if (loader) loader.classList.add('hidden');
  }, 400);

  const initialCountry = await loadCountries();
  currentCountry = initialCountry || 'BD';

  loadCountryData(currentCountry);

  planesInterval = setInterval(() => {
    if (!document.hidden && !HEAVY_COUNTRIES.includes(currentCountry)) {
      loadPlanes(currentCountry, true);
    }
  }, 30000);

  console.log('✅ SkyScope ready');
}

async function loadCountryData(code) {
  try {
    fitToBounds(code);

    await Promise.allSettled([
      fetchAirports(code).then(airports => drawAirports(airports || [])),
      loadPlanes(code),
      loadCountryInfo(code)
    ]);

    const country = allCountries.find(c => c.cca2 === code);
    if (country) updateStatusCountry(country.name.common);

    localStorage.setItem('skyscope_country', code);

  } catch (err) {
    console.error('Load country data error:', err);
  }
}

async function fetchAirports(code) {
  if (airportsAbortController) airportsAbortController.abort();
  airportsAbortController = new AbortController();
  const myRequestId = ++airportsRequestId;

  const cached = airportsCache.get(code);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(`${APP_API}/airports?country=${code}&limit=${MAX_AIRPORTS}`, {
      signal: airportsAbortController.signal
    });

    if (myRequestId !== airportsRequestId) return [];

    if (!res.ok) return [];
    const data = await res.json();
    airportsCache.set(code, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return [];
    console.error('Airports fetch error:', err);
    return [];
  }
}

async function loadPlanes(code, silent = false) {
  // 1. Cancel any pending plane request
  if (planesAbortController) {
    planesAbortController.abort();
  }
  planesAbortController = new AbortController();
  const myRequestId = ++planesRequestId;

  // 2. Instant UI feedback
  const cached = planesCache.get(code);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    drawPlanes(cached.planes);
    updateStatusUpdated();
  } else {
    if (!silent) {
      drawPlanes([]);
      showPlanesLoading(true);
    }
  }

  // 3. Fetch fresh data
  try {
    const res = await fetch(`${APP_API}/planes/live?country=${code}`, {
      signal: planesAbortController.signal
    });

    if (myRequestId !== planesRequestId) {
      return;
    }

    let planes = await res.json();

    if (!res.ok) {
      if (!silent) showToast(planes.error || 'Failed to load planes', 'warning');
      showPlanesLoading(false);
      return;
    }

    // 4. Filter to country bounding box
    const bounds = (typeof COUNTRY_BOUNDS !== 'undefined') ? COUNTRY_BOUNDS[code] : null;
    if (bounds && Array.isArray(planes)) {
      const [lamin, lamax, lomin, lomax] = bounds;
      planes = planes.filter(p => {
        const lat = Number(p.latitude);
        const lon = Number(p.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        return lat >= lamin && lat <= lamax && lon >= lomin && lon <= lomax;
      });
    }

    // 5. Cap plane count — reserve 30 slots for grounded planes
    if (Array.isArray(planes) && planes.length > MAX_PLANES) {
      const flying = planes.filter(p => !p.on_ground);
      const grounded = planes.filter(p => p.on_ground);
      const flyingCap = MAX_PLANES - 30;
      planes = [
        ...flying.slice(0, flyingCap),
        ...grounded.slice(0, 30)
      ];
    }

    // 6. Cache + render
    planesCache.set(code, { planes, timestamp: Date.now() });

    if (myRequestId === planesRequestId) {
      drawPlanes(planes);
      updateStatusUpdated();
      showPlanesLoading(false);

      if (planes.length === 0 && !silent) {
        const countryName = (typeof allCountries !== 'undefined')
          ? (allCountries.find(c => c.cca2 === code)?.name?.common || code)
          : code;
        showToast(`✈️ No aircraft currently over ${countryName}. Try a busier country like India, USA, or UAE.`, 'info');
      }

      if (!silent) {
        const groundedCount = planes.filter(p => p.on_ground).length;
        console.log(`✈️ ${code}: ${planes.length} planes (${groundedCount} on ground)`);
      }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    console.error('Planes fetch error:', err);
    if (!silent) showToast('Planes unavailable', 'warning');
    showPlanesLoading(false);
  }
}

function showPlanesLoading(isLoading) {
  const el = document.getElementById('planeCount');
  const el2 = document.getElementById('statusPlanes');

  if (isLoading) {
    if (el) el.innerHTML = '<span class="loading-dots">...</span>';
    if (el2) el2.innerHTML = '<span class="loading-dots">...</span>';
  }
}

document.getElementById('countrySelect').addEventListener('change', async (e) => {
  const code = e.target.value;
  if (!code) return;

  currentCountry = code;
  airportMarkers = [];
  planeMarkers = [];

  await loadCountryData(code);

  const country = allCountries.find(c => c.cca2 === code);
  if (country) {
    showToast(`Now viewing ${country.flag} ${country.name.common}`, 'info');
  }
});

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchTimeout = null;

searchInput.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimeout);

  if (q.length < 2) {
    searchResults.classList.remove('show');
    return;
  }

  searchTimeout = setTimeout(() => performSearch(q), 300);
});

async function performSearch(q) {
  try {
    const res = await fetch(`${APP_API}/airports/search?q=${encodeURIComponent(q)}`);
    const results = await res.json();

    if (results.length === 0) {
      searchResults.innerHTML = '<div class="search-result-item"><span class="name">No results</span></div>';
      searchResults.classList.add('show');
      return;
    }

    searchResults.innerHTML = results.map(a => `
      <div class="search-result-item" data-lat="${a.latitude_deg}" data-lng="${a.longitude_deg}" data-name="${escapeAttr(a.name)}">
        <span class="name">🏢 ${escapeHtml(a.name)}</span>
        <div class="meta">${escapeHtml(a.municipality || 'Unknown')} · ${a.iata_code || a.ident} · ${a.iso_country}</div>
      </div>
    `).join('');

    searchResults.classList.add('show');

    searchResults.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const lat = parseFloat(el.dataset.lat);
        const lng = parseFloat(el.dataset.lng);
        const name = el.dataset.name;

        if (!isNaN(lat) && !isNaN(lng)) {
          flyTo(lat, lng, 12);
          showToast(`📍 Flying to ${name}`, 'info');
        }

        searchResults.classList.remove('show');
        searchInput.value = '';
      });
    });

  } catch (err) {
    console.error('Search error:', err);
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.navbar-search')) {
    searchResults.classList.remove('show');
  }
});

document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported', 'error');
    return;
  }

  const btn = document.getElementById('locateBtn');
  btn.classList.add('active');

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      flyTo(latitude, longitude, 8);
      showToast('📍 Located! Detecting country...', 'info');

      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
        const data = await res.json();
        const countryCode = data.address?.country_code?.toUpperCase();

        if (countryCode && allCountries.find(c => c.cca2 === countryCode)) {
          document.getElementById('countrySelect').value = countryCode;
          document.getElementById('countrySelect').dispatchEvent(new Event('change'));
          showToast(`Detected: ${countryCode}`, 'success');
        }
      } catch (e) {
        console.warn('Reverse geocode failed:', e);
      }

      btn.classList.remove('active');
    },
    (err) => {
      showToast('Location access denied', 'warning');
      btn.classList.remove('active');
    },
    { timeout: 10000 }
  );
});

document.getElementById('infoBtn').addEventListener('click', () => {
  const panel = document.getElementById('infoPanel');
  if (panel.classList.contains('open')) {
    closeInfoPanel();
    document.getElementById('infoBtn').classList.remove('active');
  } else {
    openInfoPanel();
    document.getElementById('infoBtn').classList.add('active');
    if (typeof loadCountryNews === 'function') loadCountryNews();
  }
});

document.getElementById('closeInfo').addEventListener('click', () => {
  closeInfoPanel();
  document.getElementById('infoBtn').classList.remove('active');
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  if (!confirm('Log out?')) return;
  localStorage.removeItem('user');
  window.location.href = 'index.html';
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

initApp();
