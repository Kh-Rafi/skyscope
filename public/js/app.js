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

let planesAbortController = null;
let airportsAbortController = null;
let planesRequestId = 0;
let airportsRequestId = 0;

const planesCache = new Map();
const airportsCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

const prefetchedCountries = new Set();

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
  if (planesAbortController) {
    planesAbortController.abort();
  }
  planesAbortController = new AbortController();
  const myRequestId = ++planesRequestId;

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

  try {
    const res = await fetch(`${APP_API}/planes/live?country=${code}`, {
      signal: planesAbortController.signal
    });

    if (myRequestId !== planesRequestId) {
      return;
    }

    let planes = await res.json();

    // ---- Handle server error response ----
    if (!res.ok) {
      // If we have stale cache, silently use it (don't scare the user)
      const stale = planesCache.get(code);
      if (stale) {
        drawPlanes(stale.planes);
        updateStatusUpdated();
        showPlanesLoading(false);
        if (!silent) {
          showToast(
            '⚠️ Live data temporarily unavailable — showing last known positions.',
            'warning',
            6000
          );
        }
        return;
      }

      // No cache at all — show a real error
      showPlanesLoading(false);
      if (!silent) {
        const msg = planes.error || 'Flight data unavailable';
        showToast(`⚠️ ${msg}. Try again in a moment.`, 'warning', 6000);
      }
      return;
    }

    // ---- Filter to country bounding box ----
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

    // ---- Cap plane count — reserve 30 slots for grounded planes ----
    if (Array.isArray(planes) && planes.length > MAX_PLANES) {
      const flying = planes.filter(p => !p.on_ground);
      const grounded = planes.filter(p => p.on_ground);
      const flyingCap = MAX_PLANES - 30;
      planes = [
        ...flying.slice(0, flyingCap),
        ...grounded.slice(0, 30)
      ];
    }

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
        const flyingCount = planes.length - groundedCount;
        console.log(`✈️ ${code}: ${planes.length} planes (${flyingCount} flying, ${groundedCount} on ground)`);
      }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    console.error('Planes fetch error:', err);

    // Try stale cache on network error too
    const stale = planesCache.get(code);
    if (stale) {
      drawPlanes(stale.planes);
      updateStatusUpdated();
      showPlanesLoading(false);
      if (!silent) {
        showToast('⚠️ Network issue — showing last known positions.', 'warning', 6000);
      }
      return;
    }

    if (!silent) {
      showToast('⚠️ Flight data unavailable. Check your connection and try again.', 'warning', 6000);
    }
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

// === NEW: dedicated counter updater (shows flying / grounded split) ===
function updatePlaneCounter(total, grounded) {
  const flying = total - grounded;

  const badge = document.getElementById('planeCount');
  const status = document.getElementById('statusPlanes');

  // Compact format for the badge: "42 (8 on ground)"
  const badgeHtml = total === 0
    ? '0'
    : `${total}<span style="opacity:0.65; font-weight:500; font-size:11px; margin-left:4px;">(${grounded} on ground)</span>`;

  if (badge) badge.innerHTML = badgeHtml;

  // Full format for the status bar: "✈️ 34 flying · 🛬 8 on ground"
  if (status) {
    status.innerHTML = total === 0
      ? '0'
      : `<span style="color:#e53935;">✈️ ${flying}</span> · <span style="color:#43a047;">🛬 ${grounded}</span>`;
  }
}

function prefetchCountry(code) {
  if (!code) return;
  if (prefetchedCountries.has(code)) return;
  prefetchedCountries.add(code);

  const cached = planesCache.get(code);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return;

  console.log(`[prefetch-client] warming ${code}`);
  fetch(`${APP_API}/planes/live?country=${code}`)
    .then(res => res.json())
    .then(planes => {
      if (Array.isArray(planes)) {
        planesCache.set(code, { planes, timestamp: Date.now() });
        console.log(`[prefetch-client] ✅ ${code} cached (${planes.length} planes)`);
      }
    })
    .catch(err => {
      console.warn(`[prefetch-client] ❌ ${code}: ${err.message}`);
      prefetchedCountries.delete(code);
    });
}

const countrySelectEl = document.getElementById('countrySelect');

countrySelectEl.addEventListener('mousedown', () => {
  const options = Array.from(countrySelectEl.options).slice(0, 5);
  options.forEach(opt => {
    if (opt.value && opt.value !== currentCountry) {
      prefetchCountry(opt.value);
    }
  });
});

countrySelectEl.addEventListener('mouseover', (e) => {
  if (e.target.tagName === 'OPTION') {
    const code = e.target.value;
    if (code && code !== currentCountry) {
      prefetchCountry(code);
    }
  }
});

countrySelectEl.addEventListener('change', async (e) => {
  const code = e.target.value;
  if (!code) return;

  currentCountry = code;
  airportMarkers = [];
  planeMarkers = [];

  // ---- NEW: clear any active driving route when switching countries ----
  if (typeof clearRoute === 'function') clearRoute();

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
