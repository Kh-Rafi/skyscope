



const COUNTRY_API = '/api';

let allCountries = [];


async function loadCountries() {
  try {
    const res = await fetch(`${COUNTRY_API}/countries`);
    allCountries = await res.json();

    const select = document.getElementById('countrySelect');
    select.innerHTML = '<option value="">🌍 Select country</option>';

    allCountries.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.cca2;
      opt.textContent = `${c.flag} ${c.name.common}`;
      select.appendChild(opt);
    });

    console.log(`✅ Loaded ${allCountries.length} countries into dropdown`);

    const saved = localStorage.getItem('skyscope_country');
    if (saved && allCountries.find(c => c.cca2 === saved)) {
      select.value = saved;
    } else {
      const lang = navigator.language || 'en-US';
      const code = lang.split('-')[1];
      if (code && allCountries.find(c => c.cca2 === code)) {
        select.value = code;
      } else {
        select.value = 'BD';
      }
    }

    return select.value;
  } catch (err) {
    console.error('Failed to load countries:', err);
    if (typeof showToast === 'function') showToast('Failed to load countries', 'error');
    return 'BD';
  }
}


async function loadCountryInfo(code) {
  try {
    const res = await fetch(`${COUNTRY_API}/country-info/${code}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed');

    renderCountryInfo(data);
    

    return data;
  } catch (err) {
    console.error('Country info error:', err);
    if (typeof showToast === 'function') showToast('Failed to load country info', 'error');
  }
}

function renderCountryInfo(data) {
  const c = data.country;
  const a = data.airports;

  document.getElementById('infoFlag').textContent = c.flag;
  document.getElementById('infoName').textContent = c.name.common;
  document.getElementById('infoOfficial').textContent = c.name.official;

  document.getElementById('infoCapital').textContent = (c.capital && c.capital[0]) || '—';
  document.getElementById('infoPopulation').textContent = formatNumber(c.population);
  document.getElementById('infoRegion').textContent = c.region || '—';
  document.getElementById('infoArea').textContent = formatArea(c.area);

  document.getElementById('infoAirTotal').textContent = formatNumber(a.total);
  document.getElementById('infoAirScheduled').textContent = formatNumber(a.scheduled);

  document.getElementById('infoLanguages').textContent =
    c.languages ? Object.values(c.languages).slice(0, 3).join(', ') : '—';

  document.getElementById('infoCurrency').textContent =
    c.currencies ? Object.values(c.currencies).map(cur => `${cur.name} (${cur.symbol || ''})`).join(', ') : '—';

  document.getElementById('infoTimezones').textContent =
    c.timezones ? c.timezones.slice(0, 2).join(', ') : '—';
}


async function loadCountryNews() {
  const list = document.getElementById('newsList');
  if (!list) return;

  
  if (list.dataset.loaded === 'true') return;

  list.innerHTML = '<li class="news-item" style="color: var(--muted); font-size: 13px;">Loading news...</li>';

  try {
    const res = await fetch(`${COUNTRY_API}/news?limit=5`);
    const news = await res.json();

    if (!news || news.length === 0) {
      list.innerHTML = '<li class="news-item" style="color: var(--muted); font-size: 13px;">No news available</li>';
      return;
    }

    list.innerHTML = news.slice(0, 5).map(n => `
      <li class="news-item">
        <a href="${n.link}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
        <div class="meta">
          <span class="news-source">${escapeHtml(n.source)}</span>
          <span>${timeAgo(n.pubDate)}</span>
        </div>
      </li>
    `).join('');

    list.dataset.loaded = 'true';

  } catch (err) {
    console.error('News error:', err);
    list.innerHTML = '<li class="news-item" style="color: var(--muted); font-size: 13px;">Failed to load news</li>';
  }
}


function openInfoPanel() {
  const panel = document.getElementById('infoPanel');
  if (panel) panel.classList.add('open');
}


function closeInfoPanel() {
  const panel = document.getElementById('infoPanel');
  if (panel) panel.classList.remove('open');
}


function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatArea(a) {
  if (!a) return '—';
  return a.toLocaleString() + ' km²';
}

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}